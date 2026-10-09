// Reference-counted render-on-demand gate around 3d-force-graph's
// pauseAnimation/resumeAnimation — the library otherwise renders every frame of
// a settled scene (20–30% CPU). Rules: forceGraph/CLAUDE.md → "Render loop".
//
// The loop runs while any reason is held:
//   - `engine`: sim hot; acquired on data load/reheat, released by `onEngineStop`.
//   - `interact`: pointer activity on the canvas; auto-released after idle.
//   - `refresh`: a few frames after `graph.refresh()` so new `nodeThreeObject`s
//     paint and hover re-raycasts.
//   - `labelPhysics`: an overlay's per-frame repulsion loop (owning hook).
//   - `agents`: APL motion. `useAgentOverlay` holds it ONLY while
//     `AgentOverlay.tick` reports motion, never for an agent's lifetime (that
//     kept a settled agent's scene rendering).
//   - `halo`: selection-halo pulse; held only while a selection exists.
// A hidden tab or collapsed (0×0) container pauses regardless. When only the
// slow reasons (`agents`/`labelPhysics`/`halo`) are held, the loop is
// duty-cycled to ~SLOW_FPS via pause/resume, fed by `notifyFrameRendered`
// (wired to the scene frame driver at init).
//
// Split: `idleControllerReasons` (ledger), `idleControllerLoop` (duty-cycle
// scheduler; load-bearing RAF-recursion + deferred-pause semantics), `…Engine`
// (+ safety timer), `…Interact` (+ pointer wiring). Attached to the graph as
// `__idleController` so `clearLabelsAndRefresh` / overlay RAF loops reach it.

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
