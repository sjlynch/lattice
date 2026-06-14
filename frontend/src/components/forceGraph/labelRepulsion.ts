// Shared per-frame physics step for the floating labels added by the
// LOC, labels, and health overlays. Each registry has the same shape
// (a Set of {label, line} pairs) so the integration loop is identical
// — only the minimum desired distance differs per overlay.
//
// `repelLabels` is called from a per-overlay RAF tick. With N labels the
// pairwise force loop was O(N²); for a project with ~500 files in
// health mode that's 125k pair-checks per frame, which on top of the
// per-frame matrix math and tuple-array allocations was enough to
// starve React's commit phase and delay tooltip updates by seconds.
//
// This version uses a uniform spatial grid (cell size = minDist) so each
// label only checks its 3×3 neighbourhood — O(N·k) where k is the
// average cluster density. All per-frame scratch arrays are reused at
// module scope to keep GC pressure flat. `repelLabels` returns whether
// every label has settled; `labelRepulsionFrames.startLabelRepulsion` uses
// that to hold the idle controller's `labelPhysics` reason ONLY while the
// labels are still moving, so the render loop idles once they settle. (The
// stale-state cases the old always-running RAF guarded against —
// labelSpread / labelMode / refresh changes — still re-run the step for free,
// because each wakes the render loop through its own idle reason and the step
// is driven off the shared scene frame driver.)
//
// This file is a thin facade. The implementation is split by concern
// under `labelPhysics/`:
//   - physics.ts        — tuning constants
//   - scratchBuffers.ts — reused per-frame buffers + grid bucket pool
//   - spatialGrid.ts    — grid build + pairwise repulsion phase
//   - integration.ts    — per-label state, home forces, velocity/rest
//   - repel.ts          — the main per-frame `repelLabels` entry point

export type {
  RepulsionEntry,
  LabelState,
  WorldXZ,
  ForceAccumulators,
} from './labelPhysics/types';

export {
  cleanupStaleRegistryEntries,
  snapshotWorldXZ,
  createForceAccumulators,
  accumulateHomeForces,
  getOrCreateLabelState,
  integrateLabelState,
  integrateEntryMotion,
  updateConnectorEndpoint,
} from './labelPhysics/integration';

export {
  zeroDistanceJitter,
  accumulatePairwiseForces,
} from './labelPhysics/spatialGrid';

export { repelLabels } from './labelPhysics/repel';
