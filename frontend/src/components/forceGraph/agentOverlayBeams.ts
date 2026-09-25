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
  SATELLITE_TETHER_OPACITY,
} from './agentOverlayConstants';
import type { Beam } from './agentOverlayTypes';

// Shared construction for both focus beams and satellite tethers: a two-point
// geometry, a transparent depth-disabled line material, and a non-raycasting
// THREE.Line at the beam render order. The varying bits — opacity and the
// `normPath`/`openedAt` metadata — come in as arguments. The two-point geometry
// is filled each frame by updateBeam/updateBeamEndpoints.
function makeBeam(
  color: string,
  opacity: number,
  normPath: string,
  openedAt: number,
): Beam {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(6), 3),
  );
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
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

// Build a beam line (the caller adds it to the group). It opens fully-lit and
// persistent (endAt = Infinity) until the overlay demotes or expires it.
export function createBeam(color: string, normPath: string, openedAt: number): Beam {
  return makeBeam(color, BEAM_MAX_OPACITY, normPath, openedAt);
}

// A tether is a persistent, constant-opacity line from a parent agent node to
// one of its satellites. It reuses the Beam shape (line/material/geometry +
// endpoint cache) but is never faded — `updateBeamEndpoints` refreshes only its
// geometry, leaving the dimmer tether opacity set here untouched.
export function createTether(color: string): Beam {
  return makeBeam(color, SATELLITE_TETHER_OPACITY, '', 0);
}

// A label leader (node → a label the spreader pushed aside): same shape as a
// tether, at its own constant opacity.
export function createLeader(color: string, opacity: number): Beam {
  return makeBeam(color, opacity, '', 0);
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

// Refresh a beam/tether's endpoints, re-uploading geometry to the GPU only when
// an endpoint actually moved beyond BEAM_MOVE_EPS (Part B) — a line over
// stationary nodes would otherwise re-upload identical geometry every frame.
// Does NOT touch opacity, so a tether keeps its fixed opacity; `updateBeam`
// layers the fade on top for focus beams.
export function updateBeamEndpoints(
  beam: Beam,
  from: THREE.Vector3,
  to: THREE.Vector3,
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
}

// Refresh a focus beam's endpoints (node → file node) and fade its opacity by
// the remaining TTL. The geometry re-upload is gated as above, but the opacity/
// fade update always runs so finite-life (fading) beams still ramp out.
// `opacityFactor` dims satellite beams relative to the parent's (default 1).
export function updateBeam(
  beam: Beam,
  from: THREE.Vector3,
  to: THREE.Vector3,
  now: number,
  opacityFactor = 1,
): void {
  updateBeamEndpoints(beam, from, to);
  beam.material.opacity =
    BEAM_MAX_OPACITY * opacityFactor * beamFade(beam.endAt - now);
}
