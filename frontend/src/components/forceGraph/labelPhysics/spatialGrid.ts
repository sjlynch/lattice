// Uniform spatial grid (cell size = minDist) + pairwise repulsion phase.
//
// Instead of the naive O(N²) all-pairs check, each label is bucketed into
// a grid cell and only compared against its 3×3 neighbourhood — O(N·k)
// where k is the average cluster density. Reads world positions from the
// shared scratch buffers; the grid itself (packed integer cell keys, pooled
// buckets, the neighbour cursor) is the shared `../linkedCellGrid.ts`, held as
// the module-level `labelGrid` so its buckets recycle across frames.

import { PUSH_K, ZERO_DISTANCE_EPS, ZERO_DISTANCE_JITTER } from './physics';
import type { WorldXZ } from './types';
import { worldX, worldZ, labelGrid, ensureCapacity } from './scratchBuffers';

export function zeroDistanceJitter(i: number, j: number): WorldXZ {
  const angle = (i * 12.9898 + j * 78.233) % (Math.PI * 2);
  return [
    Math.cos(angle) * ZERO_DISTANCE_JITTER,
    Math.sin(angle) * ZERO_DISTANCE_JITTER,
  ];
}

export function buildSpatialGridFromScratch(
  count: number,
  cellSize: number,
): void {
  labelGrid.reset(count);
  for (let i = 0; i < count; i++) {
    // The grid stashes the integer cell coords so the pairwise pass below
    // reuses them instead of recomputing the same floor/divide.
    labelGrid.insert(
      i,
      Math.floor(worldX[i] / cellSize),
      Math.floor(worldZ[i] / cellSize),
    );
  }
}

export function pairwiseGrid(
  count: number,
  minDist: number,
  fx: Float32Array,
  fz: Float32Array,
): void {
  const minDist2 = minDist * minDist;
  for (let i = 0; i < count; i++) {
    // Each pair once (j > i), from the 3×3 neighbourhood of the cell computed
    // during the build pass (cellSize === minDist for the live path).
    labelGrid.visitNeighbors(i);
    for (let j = labelGrid.nextNeighbor(); j >= 0; j = labelGrid.nextNeighbor()) {
      let xd = worldX[j] - worldX[i];
      let zd = worldZ[j] - worldZ[i];
      let d2 = xd * xd + zd * zd;
      if (d2 >= minDist2) continue;
      if (d2 <= ZERO_DISTANCE_EPS) {
        const j2 = zeroDistanceJitter(i, j);
        xd = j2[0];
        zd = j2[1];
        d2 = xd * xd + zd * zd;
      }
      const d = Math.sqrt(d2);
      const overlap = (minDist - d) / minDist;
      const push = overlap * PUSH_K;
      const nx = xd / d;
      const nz = zd / d;
      fx[i] -= nx * push;
      fz[i] -= nz * push;
      fx[j] += nx * push;
      fz[j] += nz * push;
    }
  }
}

// Legacy entry point kept for the unit tests in
// `__tests__/labelRepulsion.test.ts`. Forwards to the grid path via the
// shared scratch buffers — same result, just O(N·k) instead of O(N²).
export function accumulatePairwiseForces(
  worldXZ: readonly WorldXZ[],
  minDist: number,
  fx: Float32Array,
  fz: Float32Array,
): void {
  const count = worldXZ.length;
  if (count === 0) return;
  ensureCapacity(count);
  for (let i = 0; i < count; i++) {
    worldX[i] = worldXZ[i][0];
    worldZ[i] = worldXZ[i][1];
  }
  buildSpatialGridFromScratch(count, minDist);
  pairwiseGrid(count, minDist, fx, fz);
}
