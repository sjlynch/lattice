// Focus-beam geometry/material lifecycle for the Claude-agent overlay: create
// the THREE.Line, dispose it, and per-frame refresh its endpoints + TTL fade.
// The current-vs-fading TTL *policy* lives in agentOverlay.ts; this module only
// owns the three.js objects and the opacity ramp.

import * as THREE from 'three';
import {
  BEAM_MAX_OPACITY,
  BEAM_MOVE_EPS,
  BEAM_RENDER_ORDER,
  FADE_MS,
} from './agentOverlayConstants';
import type { Beam } from './agentOverlayTypes';

// Build a beam line (the caller adds it to the group). Its two-point geometry
// is filled each frame by updateBeam; it opens fully-lit and persistent
// (endAt = Infinity) until the overlay demotes or expires it.
export function createBeam(color: string, normPath: string, openedAt: number): Beam {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(6), 3),
  );
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: BEAM_MAX_OPACITY,
    depthWrite: false,
    depthTest: false,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = BEAM_RENDER_ORDER;
  line.raycast = () => {};
  return {
    line,
    material,
    geometry,
    normPath,
    openedAt,
    endAt: Infinity,
    // NaN so the first updateBeam always uploads.
    lastFromX: NaN,
    lastFromY: NaN,
    lastFromZ: NaN,
    lastToX: NaN,
    lastToY: NaN,
    lastToZ: NaN,
  };
}

export function disposeBeam(group: THREE.Group, beam: Beam): void {
  group.remove(beam.line);
  beam.geometry.dispose();
  beam.material.dispose();
}

// Opacity ramp: full until the last FADE_MS of the TTL, then linearly to 0.
// Pure, so it can be unit-tested.
export function beamFade(remaining: number): number {
  return remaining < FADE_MS ? Math.max(0, remaining / FADE_MS) : 1;
}

// Whether `next` moved beyond BEAM_MOVE_EPS from `last`. NaN (uninitialized
// `last`) always counts as moved, so the first frame uploads.
function endpointMoved(next: number, last: number): boolean {
  return !(Math.abs(next - last) <= BEAM_MOVE_EPS);
}

// Refresh a beam's endpoints (agent node → file node) and fade its opacity by
// the remaining TTL. The geometry is re-uploaded to the GPU only when an
// endpoint actually moved (Part B) — a persistent beam over stationary nodes
// would otherwise re-upload identical geometry every frame — but the opacity/
// fade update always runs so finite-life (fading) beams still ramp out.
export function updateBeam(
  beam: Beam,
  from: THREE.Vector3,
  to: THREE.Vector3,
  now: number,
): void {
  if (
    endpointMoved(from.x, beam.lastFromX) ||
    endpointMoved(from.y, beam.lastFromY) ||
    endpointMoved(from.z, beam.lastFromZ) ||
    endpointMoved(to.x, beam.lastToX) ||
    endpointMoved(to.y, beam.lastToY) ||
    endpointMoved(to.z, beam.lastToZ)
  ) {
    const attr = beam.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    beam.lastFromX = from.x;
    beam.lastFromY = from.y;
    beam.lastFromZ = from.z;
    beam.lastToX = to.x;
    beam.lastToY = to.y;
    beam.lastToZ = to.z;
  }
  beam.material.opacity = BEAM_MAX_OPACITY * beamFade(beam.endAt - now);
}
