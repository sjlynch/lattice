// Thin facade over `labelPhysics/` — the shared per-frame repulsion step for the
// floating labels of the LOC, labels and health overlays (same registry shape;
// only the minimum distance differs). Model, tick and module map:
// labelPhysics/CLAUDE.md.
//
// A uniform grid (cell = minDist, 3×3 neighbourhood: O(N·k)) replaces the O(N²)
// pairwise loop, which starved React's commit phase at ~500 labels; per-frame
// scratch is reused at module scope to keep GC pressure flat. `repelLabels`
// returns whether every label settled, and
// `labelRepulsionFrames.startLabelRepulsion` holds the idle controller's
// `labelPhysics` reason ONLY while labels move. labelSpread / labelMode / refresh
// changes still re-run the step: each wakes the loop through its own idle reason
// and the step rides the shared scene frame driver.

export type {
  RepulsionEntry,
  LabelState,
  WorldXZ,
} from './labelPhysics/types';

export {
  cleanupStaleRegistryEntries,
  snapshotWorldXZ,
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
