// Reference-counted controller around 3d-force-graph's pauseAnimation /
// resumeAnimation. The library otherwise runs a continuous RAF render loop
// even with a fully settled scene — burning 20–30% CPU on a focused tab.
//
// Animation runs while any "reason" is held:
//   - `engine`        : the d3 force simulation is still hot. Acquired on
//                       data load / physics reheat, released by
//                       `graph.onEngineStop`.
//   - `interact`      : the user is moving / clicking / scrolling on the
//                       canvas. Auto-released after a short idle.
//   - `refresh`       : `graph.refresh()` was just called — drives a few
//                       frames so the new `nodeThreeObject` results paint
//                       and the raycaster re-evaluates hover.
//   - `labelPhysics`  : an overlay (LOC / health / labels) is running its
//                       per-frame repulsion loop. Acquired/released by the
//                       owning hook.
//   - `agents`        : the Agent Presence Layer (Claude presence nodes +
//                       focus beams) has self-driven motion to paint — a node
//                       easing, the hover line settling, or a beam fading. Held
//                       by `useAgentOverlay` ONLY while `AgentOverlay.tick`
//                       reports motion, NOT for an agent's whole lifetime, so a
//                       settled-but-still-running agent lets the loop idle. (It
//                       used to be held while any agent existed — the
//                       render-on-demand regression this file's contract now
//                       guards against.)
//
// Tab visibility is a negative gate: when the tab is hidden the loop is
// fully paused regardless of held reasons.
//
// Frame-rate throttle: when the ONLY held reasons are the slow self-animations
// (`agents` and/or `labelPhysics`) — i.e. no `engine` warmup, `interact`, or
// `refresh` tail demanding full responsiveness — the loop is duty-cycled down
// to ~SLOW_FPS via pause/resume. Those eases/fades read fine at a reduced rate,
// so this roughly halves the full-scene render cost while an agent is active or
// a label overlay is held, without affecting interaction or layout warmup. Fed
// one frame at a time by `notifyFrameRendered` (wired to the scene frame
// driver at init).
//
// The controller is attached to the graph instance as `__idleController`
// so utilities like `clearLabelsAndRefresh` and the overlay RAF loops can
// reach it without threading another ref through every hook.

import type { ForceGraph3DInstance } from '3d-force-graph';

const INTERACT_IDLE_MS = 350;
const POINTER_LEAVE_TAIL_MS = 80;
const REFRESH_TAIL_MS = 120;
// Belt-and-braces auto-release for the `engine` reason. The library
// normally fires `onEngineStop` within `cooldownTime` (now 8 s, see
// useForceGraphInitialization), but on the off chance an upstream
// change ever drops or swallows the callback we don't want the render
// loop pinned forever. Sized comfortably above cooldownTime + a margin
// for the warmup ticks.
const ENGINE_SAFETY_TIMEOUT_MS = 20000;
// Duty-cycle target when only the slow self-animations are driving the loop.
// ~30fps halves the render cost vs the library's uncapped ~60fps while staying
// visually smooth for node easing + beam/label fades.
const SLOW_FRAME_MS = 1000 / 30;

export type IdleController = {
  engineStarted(): void;
  engineStopped(): void;
  isEngineHot(): boolean;
  acquireLabelPhysics(): void;
  releaseLabelPhysics(): void;
  acquireAgents(): void;
  releaseAgents(): void;
  wakeForRefresh(): void;
  notifyFrameRendered(): void;
  destroy(): void;
};

type Counts = {
  engine: number;
  interact: number;
  refresh: number;
  labelPhysics: number;
  agents: number;
};

export function createIdleController(
  graph: ForceGraph3DInstance,
  container: HTMLElement,
): IdleController {
  const counts: Counts = {
    engine: 0,
    interact: 0,
    refresh: 0,
    labelPhysics: 0,
    agents: 0,
  };
  let hidden = document.visibilityState === 'hidden';
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

  function shouldRun(): boolean {
    if (hidden) return false;
    return (
      counts.engine > 0 ||
      counts.interact > 0 ||
      counts.refresh > 0 ||
      counts.labelPhysics > 0 ||
      counts.agents > 0
    );
  }

  // True when the loop is running purely for the slow self-animations and
  // nothing demands full responsiveness — the only case we duty-cycle.
  function slowOnly(): boolean {
    return (
      counts.engine === 0 &&
      counts.interact === 0 &&
      counts.refresh === 0 &&
      (counts.agents > 0 || counts.labelPhysics > 0)
    );
  }

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

  // Called once per real render frame (via the scene frame driver). In
  // slow-only mode this drives the duty cycle: pause after this frame and
  // re-wake SLOW_FRAME_MS later (~SLOW_FPS). A no-op outside slow-only mode.
  function notifyFrameRendered() {
    if (throttleTimer || pausePending) return;
    if (!shouldRun() || !slowOnly()) return;
    schedulePauseCheck();
  }

  // ---- engine (boolean, mirrors three-forcegraph's engineRunning) -------
  let engineHeld = false;
  let engineSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  function clearEngineSafety() {
    if (engineSafetyTimer) {
      clearTimeout(engineSafetyTimer);
      engineSafetyTimer = null;
    }
  }
  function armEngineSafety() {
    clearEngineSafety();
    engineSafetyTimer = setTimeout(() => {
      engineSafetyTimer = null;
      // Library failed to fire onEngineStop within the cooldown window.
      // Force-release so the render loop can suspend.
      if (engineHeld) {
        engineHeld = false;
        counts.engine--;
        sync();
      }
    }, ENGINE_SAFETY_TIMEOUT_MS);
  }
  function engineStarted() {
    if (engineHeld) {
      // Already held — just rearm the safety timer because the d3
      // engine was just re-warmed (graphData() swap or explicit reheat).
      armEngineSafety();
      return;
    }
    engineHeld = true;
    counts.engine++;
    armEngineSafety();
    sync();
  }
  function engineStopped() {
    if (!engineHeld) return;
    engineHeld = false;
    counts.engine--;
    clearEngineSafety();
    sync();
  }
  // Whether the d3 layout is currently live (nodes may be moving this frame).
  // Consumers that cache per-frame geometry derived from node positions (e.g.
  // the Agent Presence Layer's graph bounds) use this to recompute only while
  // positions can change and reuse the cache once the layout has settled.
  function isEngineHot(): boolean {
    return engineHeld;
  }

  // ---- label-physics (counter, multiple overlays may be active) ---------
  function acquireLabelPhysics() {
    counts.labelPhysics++;
    sync();
  }
  function releaseLabelPhysics() {
    if (counts.labelPhysics > 0) counts.labelPhysics--;
    sync();
  }

  // ---- agents (Claude node + focus beams animating) ---------------------
  function acquireAgents() {
    counts.agents++;
    sync();
  }
  function releaseAgents() {
    if (counts.agents > 0) counts.agents--;
    sync();
  }

  // ---- refresh (short tail after refresh() / settings tweak) ------------
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function wakeForRefresh() {
    if (refreshTimer == null) {
      counts.refresh++;
      sync();
    } else {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      counts.refresh--;
      sync();
    }, REFRESH_TAIL_MS);
  }

  // ---- interact (pointer / wheel) ---------------------------------------
  let interactHeld = false;
  let interactTimer: ReturnType<typeof setTimeout> | null = null;
  function touchInteract(tailMs: number = INTERACT_IDLE_MS) {
    if (!interactHeld) {
      interactHeld = true;
      counts.interact++;
      sync();
    }
    if (interactTimer) clearTimeout(interactTimer);
    interactTimer = setTimeout(() => {
      interactTimer = null;
      interactHeld = false;
      counts.interact--;
      sync();
    }, tailMs);
  }
  const onPointerMove = () => touchInteract();
  const onPointerDown = () => touchInteract();
  const onWheel = () => touchInteract();
  // Shorten the tail aggressively when the cursor leaves the canvas so an
  // idle tab settles back to 0 CPU sooner.
  const onPointerLeave = () => touchInteract(POINTER_LEAVE_TAIL_MS);

  container.addEventListener('pointermove', onPointerMove, { passive: true });
  container.addEventListener('pointerdown', onPointerDown, { passive: true });
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('pointerleave', onPointerLeave);

  const onVisibility = () => {
    hidden = document.visibilityState === 'hidden';
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);

  function destroy() {
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('wheel', onWheel);
    container.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    if (interactTimer) clearTimeout(interactTimer);
    if (refreshTimer) clearTimeout(refreshTimer);
    clearThrottleTimer();
    clearEngineSafety();
  }

  // Reflect the initial visibility state on construction.
  sync();

  return {
    engineStarted,
    engineStopped,
    isEngineHot,
    acquireLabelPhysics,
    releaseLabelPhysics,
    acquireAgents,
    releaseAgents,
    wakeForRefresh,
    notifyFrameRendered,
    destroy,
  };
}

// Stamp the controller onto the graph instance so utilities and hooks can
// reach it without threading another ref through the React tree.
const KEY = '__idleController' as const;

type WithController = {
  [KEY]?: IdleController;
};

export function attachIdleController(
  graph: ForceGraph3DInstance,
  controller: IdleController,
): void {
  (graph as unknown as WithController)[KEY] = controller;
}

export function getIdleController(
  graph: ForceGraph3DInstance | null,
): IdleController | null {
  if (!graph) return null;
  return (graph as unknown as WithController)[KEY] ?? null;
}
