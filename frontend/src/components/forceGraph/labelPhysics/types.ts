// Shared types for the floating-label repulsion physics. Kept in their
// own module so every physics file can depend on them without a cycle.

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
