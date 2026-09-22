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

// Returns `true` when every label is at rest — `labelRepulsionFrames.
// startLabelRepulsion` gates the idle controller's `labelPhysics` reason on it,
// releasing the hold the frame the labels settle. `onDetached` is the owning
// overlay's per-entry release for labels whose node root left the scene (see
// `cleanupStaleRegistryEntries`).
export function repelLabels(
  registry: Set<RepulsionEntry>,
  minDist: number,
  onDetached?: (entry: RepulsionEntry) => void,
): boolean {
  cleanupStaleRegistryEntries(registry, undefined, onDetached);
  const count = registry.size;
  if (count === 0) return true;

  ensureCapacity(count);

  // Snapshot world XZ + collect entries into the shared scratch buffers
  // in one pass. `ensureCapacity(count)` already ran and `count` is known,
  // so write `entries` by index (no per-member `push`) and trim any stale
  // tail once after the loop. Same contents, same order.
  let i = 0;
  for (const entry of registry) {
    entry.label.getWorldPosition(tmpVec);
    worldX[i] = tmpVec.x;
    worldZ[i] = tmpVec.z;
    entries[i] = entry;
    i++;
  }
  entries.length = count;

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
