// Focus-beam geometry/material lifecycle for the Claude-agent overlay: create
// the THREE.Line, dispose it, and per-frame refresh its endpoints + TTL fade.
// The current-vs-fading TTL *policy* lives in agentOverlay.ts; this module only
// owns the three.js objects and the opacity ramp.

import * as THREE from 'three';
import {
  BEAM_MAX_OPACITY,
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
  return { line, material, geometry, normPath, openedAt, endAt: Infinity };
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

// Refresh a beam's endpoints (agent node → file node) and fade its opacity by
// the remaining TTL.
export function updateBeam(
  beam: Beam,
  from: THREE.Vector3,
  to: THREE.Vector3,
  now: number,
): void {
  const attr = beam.geometry.getAttribute('position') as THREE.BufferAttribute;
  attr.setXYZ(0, from.x, from.y, from.z);
  attr.setXYZ(1, to.x, to.y, to.z);
  attr.needsUpdate = true;
  beam.material.opacity = BEAM_MAX_OPACITY * beamFade(beam.endAt - now);
}
