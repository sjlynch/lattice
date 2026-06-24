// Per-label state: registry maintenance, world snapshots, and the
// velocity/rest integration that moves each label and re-anchors its
// connector line. (The home-spring force is accumulated inline by the
// per-frame `repelLabels` in repel.ts.)

import * as THREE from 'three';
import {
  FRICTION,
  REST_VEL,
  REST_VEL_SQ,
  REST_FORCE_SQ,
  REST_FRAMES,
  LINE_EPS,
} from './physics';
import type {
  RepulsionEntry,
  LabelState,
  WorldXZ,
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
  // Squared-magnitude comparisons avoid two `Math.hypot` calls per label per
  // frame: `hypot(fx, fz) < REST_FORCE` ⇔ `fx*fx + fz*fz < REST_FORCE_SQ`
  // (both sides non-negative), same for the velocity check.
  const forceMag2 = fx * fx + fz * fz;
  const speed2 = state.vx * state.vx + state.vz * state.vz;
  const canRest = forceMag2 < REST_FORCE_SQ && speed2 < REST_VEL_SQ;
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
