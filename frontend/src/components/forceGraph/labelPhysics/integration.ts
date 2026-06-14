// Per-label state: registry maintenance, world snapshots, home-spring
// force accumulation, and the velocity/rest integration that moves each
// label and re-anchors its connector line.

import * as THREE from 'three';
import { HOME_K, FRICTION, REST_VEL, REST_FORCE, REST_FRAMES, LINE_EPS } from './physics';
import type {
  RepulsionEntry,
  LabelState,
  WorldXZ,
  ForceAccumulators,
} from './types';

// Velocity is owned by the sprite (one velocity per label). Using a
// WeakMap means a registry entry that gets dropped via `registry.delete`
// also has its velocity GC'd along with the sprite — no manual cleanup
// needed in the parent component.
export const stateMap = new WeakMap<THREE.Sprite, LabelState>();

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
