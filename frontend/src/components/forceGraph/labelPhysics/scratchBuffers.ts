// Reusable per-frame scratch buffers + the label spatial grid.
//
// All typed arrays are sized in lockstep by `ensureCapacity(n)`. Growing them
// keeps the previous (smaller) arrays alive only briefly during the growth
// call. Everything here is module-level mutable state shared across a single
// `repelLabels` tick — keeping it in one place makes the buffer-reuse
// semantics (and the GC-pressure guarantee) easy to audit. The typed
// arrays are exported as live `let` bindings: `ensureCapacity` reassigns
// them on growth and importers observe the new array via ES-module live
// bindings, so consumers must read `worldX`/`fx`/… fresh after calling
// `ensureCapacity` rather than caching the reference.

import * as THREE from 'three';
import { LinkedCellGrid } from '../linkedCellGrid';
import type { RepulsionEntry } from './types';

let capacity = 0;
export let worldX: Float32Array = new Float32Array(0);
export let worldZ: Float32Array = new Float32Array(0);
export let fx: Float32Array = new Float32Array(0);
export let fz: Float32Array = new Float32Array(0);

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

// Rebuilt each tick by `buildSpatialGridFromScratch` (spatialGrid.ts). The grid
// owns its integer cell-coordinate scratch and recycles its bucket arrays
// through a pool, keyed by a packed integer cell identity rather than a
// `"cx,cz"` string, so a settled scene's per-frame allocations are flat.
export const labelGrid = new LinkedCellGrid();

export function ensureCapacity(n: number): void {
  if (n <= capacity) return;
  const newCap = Math.max(64, n * 2);
  worldX = new Float32Array(newCap);
  worldZ = new Float32Array(newCap);
  fx = new Float32Array(newCap);
  fz = new Float32Array(newCap);
  capacity = newCap;
}
