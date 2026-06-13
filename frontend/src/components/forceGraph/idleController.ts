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
//   - `agents`        : one or more Claude agent nodes / focus beams are on
//                       screen and being animated. Held by `useAgentOverlay`
//                       so the node easing + beam fades actually paint.
//
// Tab visibility is a negative gate: when the tab is hidden the loop is
// fully paused regardless of held reasons.
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

export type IdleController = {
  engineStarted(): void;
  engineStopped(): void;
  acquireLabelPhysics(): void;
  releaseLabelPhysics(): void;
  acquireAgents(): void;
  releaseAgents(): void;
  wakeForRefresh(): void;
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
  let running = true; // 3d-force-graph starts its own RAF on construction

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

  function sync() {
    const want = shouldRun();
    if (want === running) return;
    if (want) graph.resumeAnimation();
    else graph.pauseAnimation();
    running = want;
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
    clearEngineSafety();
  }

  // Reflect the initial visibility state on construction.
  sync();

  return {
    engineStarted,
    engineStopped,
    acquireLabelPhysics,
    releaseLabelPhysics,
    acquireAgents,
    releaseAgents,
    wakeForRefresh,
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
