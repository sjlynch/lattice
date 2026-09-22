// Frame-driver glue for the label-repulsion overlays (LOC `z`, health `h`,
// Alt-labels). Runs `repelLabels` on every real render frame (via the shared
// scene frame driver) and holds the idle controller's `labelPhysics` reason
// ONLY while the labels are still moving — releasing it the frame they settle so
// the render loop can idle instead of spinning at 60fps for the whole time the
// overlay key is held.
//
// This is the "extra wake plumbing" the old always-running RAF avoided: because
// the callback fires off `scene.onBeforeRender`, every change that perturbs the
// labels also re-runs it for free, since each such change already wakes the loop
// through its own idle reason — a labelSpread slider drag is `interact`, a
// layout reheat is `engine`, a sprite/registry rebuild is `refresh`. So a self-
// stop can't strand a stale labelSpread / labelMode the way a naive RAF stop
// would. `minDist` is a thunk so the live `labelSpread` multiplier is read fresh
// each frame.

import type { ForceGraph3DInstance } from '3d-force-graph';
import { getIdleController } from './idleController';
import { onFrame } from './sceneFrameDriver';
import { repelLabels, type RepulsionEntry } from './labelRepulsion';

export function startLabelRepulsion(
  graph: ForceGraph3DInstance | null,
  registry: Set<RepulsionEntry>,
  minDist: () => number,
  // The overlay's per-entry release for a label whose node root was detached
  // from the scene by a visibility digest (hidden-ext toggle) — see
  // `cleanupStaleRegistryEntries`.
  onDetached?: (entry: RepulsionEntry) => void,
): () => void {
  const idle = getIdleController(graph);
  let held = false;
  const acquire = () => {
    if (!held) {
      idle?.acquireLabelPhysics();
      held = true;
    }
  };
  const release = () => {
    if (held) {
      idle?.releaseLabelPhysics();
      held = false;
    }
  };

  // Wake the loop on mount so the initial layout settles even if it was idle,
  // then let the per-frame rest check hand the hold back.
  acquire();
  const off = onFrame(graph, () => {
    if (repelLabels(registry, minDist(), onDetached)) release();
    else acquire();
  });

  return () => {
    off();
    release();
  };
}
