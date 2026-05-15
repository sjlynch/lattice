// Shared per-frame physics step for the floating labels added by the
// LOC, labels, and health overlays. Each registry has the same shape
// (a Set of {label, line} pairs) so the integration loop is identical
// — only the minimum desired distance differs per overlay.
//
// The original implementation pushed labels apart by an impulse and
// damped them back toward home with a position multiplier. With no
// velocity term those two phases fought each other every frame and the
// labels never reached equilibrium — the visible "stutter / wiggle"
// the user noticed. This version uses a small velocity + friction
// integrator so the system actually settles: forces add to velocity,
// friction kills overshoot, and rest thresholds snap the label fully
// still once it's basically arrived.

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

export function accumulatePairwiseForces(
  worldXZ: readonly WorldXZ[],
  minDist: number,
  fx: Float32Array,
  fz: Float32Array,
): void {
  const minDist2 = minDist * minDist;
  for (let i = 0; i < worldXZ.length; i++) {
    for (let j = i + 1; j < worldXZ.length; j++) {
      let dx = worldXZ[j][0] - worldXZ[i][0];
      let dz = worldXZ[j][1] - worldXZ[i][1];
      let d2 = dx * dx + dz * dz;
      if (d2 >= minDist2) continue;
      if (d2 <= ZERO_DISTANCE_EPS) {
        [dx, dz] = zeroDistanceJitter(i, j);
        d2 = dx * dx + dz * dz;
      }
      const d = Math.sqrt(d2);
      const overlap = (minDist - d) / minDist;
      const push = overlap * PUSH_K;
      const nx = dx / d;
      const nz = dz / d;
      fx[i] -= nx * push;
      fz[i] -= nz * push;
      fx[j] += nx * push;
      fz[j] += nz * push;
    }
  }
}

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

export function repelLabels(
  registry: Set<RepulsionEntry>,
  minDist: number,
): void {
  cleanupStaleRegistryEntries(registry);
  const entries = Array.from(registry);
  if (entries.length === 0) return;

  // Snapshot world-space XZ for every label up front so the pairwise
  // distance check is consistent — without this the j-loop would see
  // labels that were already moved by the i-loop, biasing the result.
  const worldXZ = snapshotWorldXZ(entries);
  const { fx, fz } = createForceAccumulators(entries);

  // Pairwise repulsion every frame. The previous every-other-frame split
  // left the home spring unopposed on alternating frames, which created a
  // tiny but visible in/out wobble even after the labels should have come
  // to rest.
  accumulatePairwiseForces(worldXZ, minDist, fx, fz);

  // Integrate: v += f, v *= friction, snap-to-zero, position += v.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    integrateEntryMotion(entry, fx[i], fz[i]);
    updateConnectorEndpoint(entry);
  }
}
