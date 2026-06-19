// Uniform spatial grid (cell size = minDist) + pairwise repulsion phase.
//
// Instead of the naive O(N²) all-pairs check, each label is bucketed into
// a grid cell and only compared against its 3×3 neighbourhood — O(N·k)
// where k is the average cluster density. Reads world positions from and
// recycles grid buckets through the shared scratch buffers.

import { PUSH_K, ZERO_DISTANCE_EPS, ZERO_DISTANCE_JITTER } from './physics';
import type { WorldXZ } from './types';
import {
  worldX,
  worldZ,
  cellX,
  cellZ,
  cellGrid,
  ensureCapacity,
  recycleGrid,
  getBucket,
} from './scratchBuffers';

// Pack a (cx, cz) integer cell coordinate into a single Map key. cx/cz are
// `floor(world / cellSize)`; at Lattice's world scale (graph spans a few
// thousand units, cellSize = minDist ≈ 27–165) they stay within a few thousand
// of the origin. BIAS shifts them non-negative and STRIDE must exceed the
// largest possible `cz + BIAS`; with BIAS = 2e6 and STRIDE = 4e6 the key is
// unique for any cell coordinate in [-2e6, 2e6) (key max ≈ 4e6·4e6 = 1.6e13,
// far under Number.MAX_SAFE_INTEGER ≈ 9e15) — orders of magnitude beyond any
// real graph. The key is an opaque per-cell bucket identity: a pure
// representation change from the old `"cx,cz"` string, same neighbour set.
const CELL_KEY_BIAS = 2_000_000;
const CELL_KEY_STRIDE = 4_000_000;
function cellKey(cx: number, cz: number): number {
  return (cx + CELL_KEY_BIAS) * CELL_KEY_STRIDE + (cz + CELL_KEY_BIAS);
}

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
  recycleGrid();
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(worldX[i] / cellSize);
    const cz = Math.floor(worldZ[i] / cellSize);
    // Stash the integer cell coords so the pairwise pass below can reuse them
    // instead of recomputing the same floor/divide.
    cellX[i] = cx;
    cellZ[i] = cz;
    const key = cellKey(cx, cz);
    let bucket = cellGrid.get(key);
    if (!bucket) {
      bucket = getBucket();
      cellGrid.set(key, bucket);
    }
    bucket.push(i);
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
    // Reuse the cell coords computed during the build pass (cellSize === minDist
    // for the live path), so no second floor/divide per label.
    const cx = cellX[i];
    const cz = cellZ[i];
    for (let dx = -1; dx <= 1; dx++) {
      // Factor the cell-key formula: the `(cx + dx + BIAS) * STRIDE` term is
      // constant across the inner dz sweep, so compute it once per dx and add
      // only `(cz + dz + BIAS)` per dz. Byte-identical keys to
      // `cellKey(cx + dx, cz + dz)`, so the same buckets are fetched.
      const rowKeyBase = (cx + dx + CELL_KEY_BIAS) * CELL_KEY_STRIDE;
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = cellGrid.get(rowKeyBase + (cz + dz + CELL_KEY_BIAS));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const j = bucket[bi];
          // Only process each pair once.
          if (j <= i) continue;
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
