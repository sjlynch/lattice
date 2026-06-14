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

// Entry list + temp vector collected once per tick by `repelLabels`.
export const entries: RepulsionEntry[] = [];
export const tmpVec = new THREE.Vector3();

// `cellGrid` is cleared and rebuilt each call; its bucket arrays come
// from `bucketPool` (reused) rather than being freshly allocated, so a
// settled scene's per-frame allocations are flat.
export const cellGrid = new Map<string, number[]>();
const bucketPool: number[][] = [];

export function ensureCapacity(n: number): void {
  if (n <= capacity) return;
  const newCap = Math.max(64, n * 2);
  worldX = new Float32Array(newCap);
  worldZ = new Float32Array(newCap);
  fx = new Float32Array(newCap);
  fz = new Float32Array(newCap);
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
