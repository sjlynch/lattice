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
//   - `halo`          : the selection-halo pulse is animating. Held by
//                       `useSelectionHaloPulse` while (and only while) a
//                       selection exists, so the shared ring material can be
//                       re-tinted each frame; released when the selection
//                       clears so the loop suspends.
//
// Tab visibility is a negative gate: when the tab is hidden the loop is
// fully paused regardless of held reasons. So is a collapsed (0×0) container —
// the graph hidden behind a full-width terminal sidebar.
//
// Frame-rate throttle: when the ONLY held reasons are the slow self-animations
// (`agents`, `labelPhysics`, and/or the selection-halo `halo` pulse) — i.e. no
// `engine` warmup, `interact`, or `refresh` tail demanding full responsiveness
// — the loop is duty-cycled down to ~SLOW_FPS via pause/resume. Those
// eases/fades/pulses read fine at a reduced rate,
// so this roughly halves the full-scene render cost while an agent is active or
// a label overlay is held, without affecting interaction or layout warmup. Fed
// one frame at a time by `notifyFrameRendered` (wired to the scene frame
// driver at init).
//
// This file is the orchestrator; the moving parts live in focused siblings:
//   - `idleControllerReasons.ts`  — the reference-counted reason ledger.
//   - `idleControllerLoop.ts`     — the pause/resume duty-cycle scheduler
//                                    (the load-bearing RAF-recursion + deferred
//                                    -pause semantics).
//   - `idleControllerEngine.ts`   — the `engine` reason + its safety timer.
//   - `idleControllerInteract.ts` — the `interact` reason + pointer DOM wiring.
// The orchestrator holds the tab-visibility gate, the trivial counter reasons
// (`labelPhysics` / `agents`) and the `refresh` tail, and wires it all together.
//
// The controller is attached to the graph instance as `__idleController`
// so utilities like `clearLabelsAndRefresh` and the overlay RAF loops can
// reach it without threading another ref through every hook.

import type { ForceGraph3DInstance } from '3d-force-graph';
import { createReasonLedger } from './idleControllerReasons';
import { createLoopScheduler } from './idleControllerLoop';
import { createEngineReason } from './idleControllerEngine';
import { createInteractReason } from './idleControllerInteract';

const REFRESH_TAIL_MS = 120;

export type IdleController = {
  engineStarted(): void;
  engineStopped(): void;
  isEngineHot(): boolean;
  acquireLabelPhysics(): void;
  releaseLabelPhysics(): void;
  acquireAgents(): void;
  releaseAgents(): void;
  acquireHalo(): void;
  releaseHalo(): void;
  wakeForRefresh(): void;
  notifyFrameRendered(): void;
  destroy(): void;
};

export function createIdleController(
  graph: ForceGraph3DInstance,
  container: HTMLElement,
): IdleController {
  const ledger = createReasonLedger();

  // Tab visibility and a collapsed container are negative gates over the held
  // reasons (see header).
  let hidden = document.visibilityState === 'hidden';
  const isCollapsed = () => !container.clientWidth || !container.clientHeight;
  let collapsed = isCollapsed();
  const shouldRun = () => !hidden && !collapsed && ledger.anyHeld();
  const slowOnly = () => ledger.slowOnly();

  const loop = createLoopScheduler(graph, shouldRun, slowOnly);
  const sync = loop.sync;

  // ---- engine (boolean, mirrors three-forcegraph's engineRunning) -------
  const engine = createEngineReason(ledger, sync);

  // ---- interact (pointer / wheel, owns its own DOM listeners) -----------
  const interact = createInteractReason(container, ledger, sync);

  // ---- label-physics (counter, multiple overlays may be active) ---------
  function acquireLabelPhysics() {
    ledger.acquire('labelPhysics');
    sync();
  }
  function releaseLabelPhysics() {
    ledger.release('labelPhysics');
    sync();
  }

  // ---- agents (Claude node + focus beams animating) ---------------------
  function acquireAgents() {
    ledger.acquire('agents');
    sync();
  }
  function releaseAgents() {
    ledger.release('agents');
    sync();
  }

  // ---- halo (selection-halo pulse animating) ----------------------------
  function acquireHalo() {
    ledger.acquire('halo');
    sync();
  }
  function releaseHalo() {
    ledger.release('halo');
    sync();
  }

  // ---- refresh (short tail after refresh() / settings tweak) ------------
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function wakeForRefresh() {
    if (refreshTimer == null) {
      ledger.acquire('refresh');
      sync();
    } else {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      ledger.release('refresh');
      sync();
    }, REFRESH_TAIL_MS);
  }

  // ---- tab visibility (negative gate) -----------------------------------
  const onVisibility = () => {
    hidden = document.visibilityState === 'hidden';
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- collapsed container (negative gate) ------------------------------
  const collapseObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const next = isCollapsed();
          if (next === collapsed) return;
          collapsed = next;
          sync();
        });
  collapseObserver?.observe(container);

  function destroy() {
    interact.destroy();
    document.removeEventListener('visibilitychange', onVisibility);
    collapseObserver?.disconnect();
    if (refreshTimer) clearTimeout(refreshTimer);
    loop.destroy();
    engine.destroy();
  }

  // Reflect the initial visibility state on construction.
  sync();

  return {
    engineStarted: engine.engineStarted,
    engineStopped: engine.engineStopped,
    isEngineHot: engine.isEngineHot,
    acquireLabelPhysics,
    releaseLabelPhysics,
    acquireAgents,
    releaseAgents,
    acquireHalo,
    releaseHalo,
    wakeForRefresh,
    notifyFrameRendered: loop.notifyFrameRendered,
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
