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
// every label has settled; the caller stops its RAF and releases the
// `labelPhysics` reason on the idle controller when that returns true,
// and `subscribeRepulsionWake` lets external triggers restart the loop.

import * as THREE from 'three';

export type RepulsionEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};

export type LabelState = { vx: number; vz: number; restFrames: number };
export type WorldXZ = readonly [number, number];
export type ForceAccumulators = {
  fx: Float32Array;
  fz: Float32Array;
};

// Velocity is owned by the sprite (one velocity per label). Using a
// WeakMap means a registry entry that gets dropped via `registry.delete`
// also has its velocity GC'd along with the sprite — no manual cleanup
// needed in the parent component.
const stateMap = new WeakMap<THREE.Sprite, LabelState>();

// Spring constant pulling each label back toward (0, _, 0) in its
// parent's local frame. Lower → labels can drift further before being
// pulled in. We keep this gentle so neighbour repulsion can dominate
// when nodes are clustered.
const HOME_K = 0.04;
// Force scaling for pairwise repulsion. Multiplied by the overlap
// fraction (MIN_DIST - d) / MIN_DIST so the push smoothly tapers off
// to zero exactly when the labels are at the requested separation.
const PUSH_K = 0.6;
// Velocity retention per frame. Lower = stronger damping = settles
// faster. 0.5 kills most overshoot within a handful of frames.
const FRICTION = 0.5;
// Velocities / residual forces below these magnitudes snap to rest so
// labels stop entirely instead of drifting at sub-pixel rates.
const REST_VEL = 0.02;
const REST_FORCE = 0.015;
const REST_FRAMES = 6;
const LINE_EPS = 0.001;
const ZERO_DISTANCE_EPS = 1e-4;
const ZERO_DISTANCE_JITTER = 0.01;

// ---- Reusable per-frame scratch buffers --------------------------------
//
// All sized in lockstep by `ensureCapacity(n)`. Growing them keeps the
// previous (smaller) arrays alive only briefly during the growth call.

let _capacity = 0;
let _worldX: Float32Array = new Float32Array(0);
let _worldZ: Float32Array = new Float32Array(0);
let _fx: Float32Array = new Float32Array(0);
let _fz: Float32Array = new Float32Array(0);
const _entries: RepulsionEntry[] = [];
const _tmpVec = new THREE.Vector3();

// `_cellGrid` is cleared and rebuilt each call; its bucket arrays come
// from `_bucketPool` (reused) rather than being freshly allocated, so a
// settled scene's per-frame allocations are flat.
const _cellGrid = new Map<string, number[]>();
const _bucketPool: number[][] = [];

function ensureCapacity(n: number): void {
  if (n <= _capacity) return;
  const newCap = Math.max(64, n * 2);
  _worldX = new Float32Array(newCap);
  _worldZ = new Float32Array(newCap);
  _fx = new Float32Array(newCap);
  _fz = new Float32Array(newCap);
  _capacity = newCap;
}

function recycleGrid(): void {
  // Return every bucket the previous call used back to the pool, then
  // clear the map for the next build.
  for (const bucket of _cellGrid.values()) {
    bucket.length = 0;
    _bucketPool.push(bucket);
  }
  _cellGrid.clear();
}

function getBucket(): number[] {
  return _bucketPool.pop() ?? [];
}

// ---- Public helpers ----------------------------------------------------

export function cleanupStaleRegistryEntries(
  registry: Set<RepulsionEntry>,
  states: WeakMap<THREE.Sprite, LabelState> = stateMap,
): void {
  for (const entry of registry) {
    if (!entry.label.parent) {
      registry.delete(entry);
      states.delete(entry.label);
    }
  }
}

export function snapshotWorldXZ(entries: readonly RepulsionEntry[]): WorldXZ[] {
  const tmp = new THREE.Vector3();
  return entries.map((entry) => {
    entry.label.getWorldPosition(tmp);
    return [tmp.x, tmp.z];
  });
}

export function createForceAccumulators(
  entries: readonly RepulsionEntry[],
): ForceAccumulators {
  const fx = new Float32Array(entries.length);
  const fz = new Float32Array(entries.length);
  accumulateHomeForces(entries, fx, fz);
  return { fx, fz };
}

export function accumulateHomeForces(
  entries: readonly RepulsionEntry[],
  fx: Float32Array,
  fz: Float32Array,
): void {
  for (let i = 0; i < entries.length; i++) {
    fx[i] = -entries[i].label.position.x * HOME_K;
    fz[i] = -entries[i].label.position.z * HOME_K;
  }
}

export function zeroDistanceJitter(i: number, j: number): WorldXZ {
  const angle = (i * 12.9898 + j * 78.233) % (Math.PI * 2);
  return [
    Math.cos(angle) * ZERO_DISTANCE_JITTER,
    Math.sin(angle) * ZERO_DISTANCE_JITTER,
  ];
}

// ---- Spatial-grid pairwise force accumulation --------------------------

function buildSpatialGridFromScratch(count: number, cellSize: number): void {
  recycleGrid();
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(_worldX[i] / cellSize);
    const cz = Math.floor(_worldZ[i] / cellSize);
    const key = `${cx},${cz}`;
    let bucket = _cellGrid.get(key);
    if (!bucket) {
      bucket = getBucket();
      _cellGrid.set(key, bucket);
    }
    bucket.push(i);
  }
}

function pairwiseGrid(
  count: number,
  minDist: number,
  fx: Float32Array,
  fz: Float32Array,
): void {
  const minDist2 = minDist * minDist;
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(_worldX[i] / minDist);
    const cz = Math.floor(_worldZ[i] / minDist);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = _cellGrid.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const j = bucket[bi];
          // Only process each pair once.
          if (j <= i) continue;
          let xd = _worldX[j] - _worldX[i];
          let zd = _worldZ[j] - _worldZ[i];
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
    _worldX[i] = worldXZ[i][0];
    _worldZ[i] = worldXZ[i][1];
  }
  buildSpatialGridFromScratch(count, minDist);
  pairwiseGrid(count, minDist, fx, fz);
}

// ---- Per-label integration --------------------------------------------

export function getOrCreateLabelState(
  label: THREE.Sprite,
  states: WeakMap<THREE.Sprite, LabelState> = stateMap,
): LabelState {
  let state = states.get(label);
  if (!state) {
    state = { vx: 0, vz: 0, restFrames: 0 };
    states.set(label, state);
  }
  return state;
}

export function integrateLabelState(
  state: LabelState,
  fx: number,
  fz: number,
): void {
  const forceMag = Math.hypot(fx, fz);
  const speed = Math.hypot(state.vx, state.vz);
  const canRest = forceMag < REST_FORCE && speed < REST_VEL;
  if (canRest) {
    state.restFrames++;
    if (state.restFrames >= REST_FRAMES) {
      state.vx = 0;
      state.vz = 0;
    }
  } else {
    state.restFrames = 0;
    state.vx = (state.vx + fx) * FRICTION;
    state.vz = (state.vz + fz) * FRICTION;
    if (Math.abs(state.vx) < REST_VEL && Math.abs(state.vz) < REST_VEL) {
      state.vx = 0;
      state.vz = 0;
    }
  }
}

export function integrateEntryMotion(
  entry: RepulsionEntry,
  fx: number,
  fz: number,
  states: WeakMap<THREE.Sprite, LabelState> = stateMap,
): void {
  const state = getOrCreateLabelState(entry.label, states);
  integrateLabelState(state, fx, fz);
  entry.label.position.x += state.vx;
  entry.label.position.z += state.vz;
}

export function updateConnectorEndpoint(entry: RepulsionEntry): boolean {
  // Anchor the connector line's upper endpoint to the label's lower
  // edge — the label's effective height changes per-frame because
  // makeLabelSprite scales it with camera distance, so we have to
  // recompute the offset every tick rather than caching it.
  const nextX = entry.label.position.x;
  const nextY = entry.label.position.y - entry.label.scale.y / 2;
  const nextZ = entry.label.position.z;
  const attr = (entry.line.geometry as THREE.BufferGeometry).getAttribute(
    'position',
  ) as THREE.BufferAttribute;

  if (
    Math.abs(attr.getX(1) - nextX) > LINE_EPS ||
    Math.abs(attr.getY(1) - nextY) > LINE_EPS ||
    Math.abs(attr.getZ(1) - nextZ) > LINE_EPS
  ) {
    attr.setXYZ(1, nextX, nextY, nextZ);
    attr.needsUpdate = true;
    return true;
  }
  return false;
}

// ---- Main per-frame entry point ---------------------------------------

// Returns `true` when every label is at rest. The owning hook uses that
// to stop its RAF and release the `labelPhysics` reason on the idle
// controller (which lets the renderer pause). Anything that invalidates
// the equilibrium calls `wakeAllRepulsion()` to restart it.
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
  _entries.length = 0;
  let i = 0;
  for (const entry of registry) {
    entry.label.getWorldPosition(_tmpVec);
    _worldX[i] = _tmpVec.x;
    _worldZ[i] = _tmpVec.z;
    _entries.push(entry);
    i++;
  }

  // Home-spring forces + clear residuals (home spring overwrites, so no
  // separate zeroing step is needed).
  for (let k = 0; k < count; k++) {
    _fx[k] = -_entries[k].label.position.x * HOME_K;
    _fz[k] = -_entries[k].label.position.z * HOME_K;
  }

  buildSpatialGridFromScratch(count, minDist);
  pairwiseGrid(count, minDist, _fx, _fz);

  let allRest = true;
  for (let k = 0; k < count; k++) {
    const entry = _entries[k];
    const state = getOrCreateLabelState(entry.label);
    integrateLabelState(state, _fx[k], _fz[k]);
    entry.label.position.x += state.vx;
    entry.label.position.z += state.vz;
    updateConnectorEndpoint(entry);
    if (state.restFrames < REST_FRAMES) allRest = false;
  }

  return allRest;
}
