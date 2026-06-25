// The loop scheduler: the half of the idle controller that actually drives
// 3d-force-graph's `pauseAnimation` / `resumeAnimation`. It owns the
// throttled slow-frame duty cycle, the deferred-pause microtask, and the
// re-entrant-resume guard — the load-bearing pause/resume semantics that
// prevent RAF recursion and idle CPU burn. It is reason-agnostic: it reads the
// current state through the injected `shouldRun` / `slowOnly` predicates (the
// orchestrator builds those from the reason ledger + the tab-hidden gate).

import type { ForceGraph3DInstance } from '3d-force-graph';

// Duty-cycle target when only the slow self-animations are driving the loop.
// ~30fps halves the render cost vs the library's uncapped ~60fps while staying
// visually smooth for node easing + beam/label fades.
const SLOW_FRAME_MS = 1000 / 30;

export type LoopScheduler = {
  // Reconcile the render loop with the current reasons. Idempotent — safe to
  // call after any acquire/release/visibility change.
  sync(): void;
  // Called once per real render frame (via the scene frame driver). In
  // slow-only mode this drives the duty cycle: pause after this frame and
  // re-wake SLOW_FRAME_MS later (~SLOW_FPS). A no-op outside slow-only mode.
  notifyFrameRendered(): void;
  // Cancel any pending throttled-frame resume (timer teardown).
  destroy(): void;
};

export function createLoopScheduler(
  graph: ForceGraph3DInstance,
  shouldRun: () => boolean,
  slowOnly: () => boolean,
): LoopScheduler {
  // `throttleTimer` holds a pending throttled-frame resume; `pausePending`
  // means a deferred pause microtask is already queued (coalesces repeats).
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let pausePending = false;
  // Guards against re-entrant resumes. `graph.resumeAnimation()` synchronously
  // runs a render tick (`_animationCycle` → `tickFrame` → `scene.onBeforeRender`)
  // BEFORE the library re-arms its RAF id, so the id is transiently null mid-tick
  // — meaning a `sync()` triggered from inside that render (e.g. a frame-driver
  // callback releasing `labelPhysics`) would see null and call resume AGAIN,
  // nesting `_animationCycle` into unbounded recursion (stack overflow). While a
  // resume is on the stack the loop is definitionally (re)starting, so any nested
  // resume request is a redundant no-op we simply skip.
  let resuming = false;

  function clearThrottleTimer() {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
  }

  // Pause the render loop, but ALWAYS from a microtask so it lands BETWEEN
  // frames. This is load-bearing: the library's `_animationCycle` re-schedules
  // its own RAF unconditionally at the end of every frame, and `onEngineStop`
  // fires synchronously *inside* that cycle (within `tickFrame`). A
  // `pauseAnimation()` called straight from `engineStopped` therefore only
  // cancels the already-fired frame and is overwritten by the cycle's trailing
  // reschedule — so the loop would never actually stop after the layout
  // settles (a perpetual-100%-CPU idle). Deferring to a microtask runs the
  // cancel after the cycle returns, when the next-frame RAF is pending and
  // genuinely cancellable.
  //
  // One unified check, shared by `sync` (we should stop) and
  // `notifyFrameRendered` (throttle: pause then re-wake). Whichever queues it,
  // the body decides from the CURRENT counts at execution time:
  //   - a full-speed reason was (re)acquired → stay running;
  //   - still slow-only → pause now and schedule the next throttled paint;
  //   - nothing wants the loop → pause and stay paused.
  function schedulePauseCheck() {
    if (pausePending) return;
    pausePending = true;
    queueMicrotask(() => {
      pausePending = false;
      if (shouldRun() && !slowOnly()) return; // full-speed reason → keep running
      if (throttleTimer) return; // a throttled resume is already scheduled
      graph.pauseAnimation();
      if (shouldRun() && slowOnly()) {
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          sync();
        }, SLOW_FRAME_MS);
      }
    });
  }

  // Resume the render loop, but never re-enter `_animationCycle` from inside the
  // render tick a resume itself drives (see the `resuming` guard above). The
  // outer resume is already (re)starting the loop, so a nested request is moot.
  function resumeLoop() {
    if (resuming) return;
    resuming = true;
    try {
      graph.resumeAnimation();
    } finally {
      resuming = false;
    }
  }

  function sync() {
    if (!shouldRun()) {
      clearThrottleTimer();
      schedulePauseCheck();
      return;
    }
    if (!slowOnly()) {
      // A full-speed reason (engine/interact/refresh) is held — run uncapped.
      clearThrottleTimer();
      resumeLoop(); // idempotent (no-op if already running / mid-resume)
      return;
    }
    // Slow-only: ensure the duty cycle is alive, but don't cut a throttle wait
    // short — that would push the effective rate above the cap.
    if (!throttleTimer && !pausePending) resumeLoop();
  }

  function notifyFrameRendered() {
    if (throttleTimer || pausePending) return;
    if (!shouldRun() || !slowOnly()) return;
    schedulePauseCheck();
  }

  function destroy() {
    clearThrottleTimer();
  }

  return { sync, notifyFrameRendered, destroy };
}
