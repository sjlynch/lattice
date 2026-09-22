// Reusable per-frame scratch buffers + spatial-grid bucket pool.
//
// All sized in lockstep by `ensureCapacity(n)`. Growing them keeps the
// previous (smaller) arrays alive only briefly during the growth call.
// Everything here is module-level mutable state shared across a single
// `repelLabels` tick — keeping it in one place makes the buffer-reuse
// semantics (and the GC-pressure guarantee) easy to audit. The typed
// arrays are exported as live `let` bindings: `ensureCapacity` reassigns
// them on growth and importers observe the new array via ES-module live
// bindings, so consumers must read `worldX`/`fx`/… fresh after calling
// `ensureCapacity` rather than caching the reference.

import * as THREE from 'three';
import type { RepulsionEntry } from './types';

let capacity = 0;
export let worldX: Float32Array = new Float32Array(0);
export let worldZ: Float32Array = new Float32Array(0);
export let fx: Float32Array = new Float32Array(0);
export let fz: Float32Array = new Float32Array(0);
// Integer cell coordinates per label, written by the grid-build pass and
// reused by the pairwise pass so the floor/divide isn't recomputed (see
// spatialGrid.ts). Sized in lockstep with the float buffers below.
export let cellX: Int32Array = new Int32Array(0);
export let cellZ: Int32Array = new Int32Array(0);

// Entry list + temp vector collected once per tick by `repelLabels`.
export const entries: RepulsionEntry[] = [];

// Drop the entry references held from the last tick. `entries` is module-level
// and only trimmed by the NEXT `repelLabels` call, which never comes once an
// overlay stops — so it kept every last-frame label sprite (material, texture,
// canvas) reachable after the registry released them, even past the texture
// cache evicting them. Safe with several overlays live: each tick rewrites it.
export function resetRepulsionScratch(): void {
  entries.length = 0;
}

export const tmpVec = new THREE.Vector3();

// `cellGrid` is cleared and rebuilt each call; its bucket arrays come
// from `bucketPool` (reused) rather than being freshly allocated, so a
// settled scene's per-frame allocations are flat. Keyed by a packed integer
// cell identity (see `cellKey` in spatialGrid.ts) rather than a `"cx,cz"`
// string, so the hot loop allocates no per-cell key strings.
export const cellGrid = new Map<number, number[]>();
const bucketPool: number[][] = [];

export function ensureCapacity(n: number): void {
  if (n <= capacity) return;
  const newCap = Math.max(64, n * 2);
  worldX = new Float32Array(newCap);
  worldZ = new Float32Array(newCap);
  fx = new Float32Array(newCap);
  fz = new Float32Array(newCap);
  cellX = new Int32Array(newCap);
  cellZ = new Int32Array(newCap);
  capacity = newCap;
}

export function recycleGrid(): void {
  // Return every bucket the previous call used back to the pool, then
  // clear the map for the next build.
  for (const bucket of cellGrid.values()) {
    bucket.length = 0;
    bucketPool.push(bucket);
  }
  cellGrid.clear();
}

export function getBucket(): number[] {
  return bucketPool.pop() ?? [];
}
