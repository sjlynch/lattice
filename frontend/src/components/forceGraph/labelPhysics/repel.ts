// Main per-frame entry point: ties the scratch buffers, spatial grid, and
// per-label integration together into one tick.

import { HOME_K, REST_FRAMES } from './physics';
import type { RepulsionEntry } from './types';
import {
  worldX,
  worldZ,
  fx,
  fz,
  entries,
  tmpVec,
  ensureCapacity,
} from './scratchBuffers';
import { buildSpatialGridFromScratch, pairwiseGrid } from './spatialGrid';
import {
  cleanupStaleRegistryEntries,
  getOrCreateLabelState,
  integrateLabelState,
  updateConnectorEndpoint,
} from './integration';

// Returns `true` when every label is at rest. Currently unused by the
// overlay hooks (they leave the RAF running) but the test suite asserts
// the integration math and the rest detection.
export function repelLabels(
  registry: Set<RepulsionEntry>,
  minDist: number,
): boolean {
  cleanupStaleRegistryEntries(registry);
  const count = registry.size;
  if (count === 0) return true;

  ensureCapacity(count);

  // Snapshot world XZ + collect entries into the shared scratch buffers
  // in one pass.
  entries.length = 0;
  let i = 0;
  for (const entry of registry) {
    entry.label.getWorldPosition(tmpVec);
    worldX[i] = tmpVec.x;
    worldZ[i] = tmpVec.z;
    entries.push(entry);
    i++;
  }

  // Home-spring forces + clear residuals (home spring overwrites, so no
  // separate zeroing step is needed).
  for (let k = 0; k < count; k++) {
    fx[k] = -entries[k].label.position.x * HOME_K;
    fz[k] = -entries[k].label.position.z * HOME_K;
  }

  buildSpatialGridFromScratch(count, minDist);
  pairwiseGrid(count, minDist, fx, fz);

  let allRest = true;
  for (let k = 0; k < count; k++) {
    const entry = entries[k];
    const state = getOrCreateLabelState(entry.label);
    integrateLabelState(state, fx[k], fz[k]);
    entry.label.position.x += state.vx;
    entry.label.position.z += state.vz;
    updateConnectorEndpoint(entry);
    if (state.restFrames < REST_FRAMES) allRest = false;
  }

  return allRest;
}
