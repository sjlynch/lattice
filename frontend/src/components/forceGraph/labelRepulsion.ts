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
// friction kills overshoot, and a rest-velocity threshold snaps the
// label fully still once it's basically arrived.

import * as THREE from 'three';

export type RepulsionEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};

type LabelState = { vx: number; vz: number };

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
// faster. 0.55 means after ~10 frames residual velocity is <0.5%.
const FRICTION = 0.55;
// Velocities below this magnitude (world units / frame) snap to 0 so
// labels stop entirely instead of drifting at sub-pixel rates.
const REST_VEL = 0.02;

export function repelLabels(
  registry: Set<RepulsionEntry>,
  minDist: number,
  frameCount: number,
): void {
  // Drop entries whose label was detached from the scene graph (e.g.
  // the underlying file node was removed when the dataset swapped).
  for (const e of registry) {
    if (!e.label.parent) {
      registry.delete(e);
      stateMap.delete(e.label);
    }
  }
  const entries = Array.from(registry);
  if (entries.length === 0) return;

  // Snapshot world-space XZ for every label up front so the pairwise
  // distance check is consistent — without this the j-loop would see
  // labels that were already moved by the i-loop, biasing the result.
  const tmp = new THREE.Vector3();
  const worldXZ: Array<[number, number]> = entries.map((e) => {
    e.label.getWorldPosition(tmp);
    return [tmp.x, tmp.z];
  });

  // Force accumulators in local-frame XZ. Float32Array because we
  // re-zero them every frame and never read between writes.
  const fx = new Float32Array(entries.length);
  const fz = new Float32Array(entries.length);

  // Home spring (always on). Pulls each label back to (0, _, 0) so
  // sparse regions don't have labels drifting far from their nodes.
  for (let i = 0; i < entries.length; i++) {
    fx[i] = -entries[i].label.position.x * HOME_K;
    fz[i] = -entries[i].label.position.z * HOME_K;
  }

  // Pairwise repulsion every other frame (O(n²); halving CPU is worth
  // it for the dense-cluster case, and at 60 fps the visual difference
  // is undetectable).
  if (entries.length > 1 && frameCount % 2 === 0) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const dx = worldXZ[j][0] - worldXZ[i][0];
        const dz = worldXZ[j][1] - worldXZ[i][1];
        const d2 = dx * dx + dz * dz;
        if (d2 < minDist * minDist && d2 > 1e-4) {
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
  }

  // Integrate: v += f, v *= friction, snap-to-zero, position += v.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let st = stateMap.get(e.label);
    if (!st) {
      st = { vx: 0, vz: 0 };
      stateMap.set(e.label, st);
    }
    st.vx = (st.vx + fx[i]) * FRICTION;
    st.vz = (st.vz + fz[i]) * FRICTION;
    if (Math.abs(st.vx) < REST_VEL) st.vx = 0;
    if (Math.abs(st.vz) < REST_VEL) st.vz = 0;
    e.label.position.x += st.vx;
    e.label.position.z += st.vz;

    // Anchor the connector line's upper endpoint to the label's lower
    // edge — the label's effective height changes per-frame because
    // makeLabelSprite scales it with camera distance, so we have to
    // recompute the offset every tick rather than caching it.
    const halfH = e.label.scale.y / 2;
    const attr = (e.line.geometry as THREE.BufferGeometry).getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    attr.setXYZ(
      1,
      e.label.position.x,
      e.label.position.y - halfH,
      e.label.position.z,
    );
    attr.needsUpdate = true;
  }
}
