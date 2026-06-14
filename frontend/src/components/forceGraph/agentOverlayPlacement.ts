// Parked-position + hover-height math for the Claude-agent overlay. Pure
// geometry/smoothing helpers (plus the small HoverLine low-pass state) kept
// apart from agentOverlay.ts so the placement math is easy to follow and test.

import * as THREE from 'three';
import {
  GOLDEN_ANGLE,
  HOVER_EASE,
  PARKED_RADIUS_FRACTION,
  PARKED_RADIUS_PADDING,
  REST_EPS,
} from './agentOverlayConstants';

// Everything parkedPosition needs about the current graph layout: the centroid
// (X/Z), the spread radius, and the hover-line height (Y).
export type ParkCenter = { cx: number; cz: number; maxR: number; y: number };

// A stable spot on the hover line (above the graph) for a freshly-spawned agent
// with no activity yet — spread around the graph centroid by index on a
// golden-angle spiral.
export function parkedPosition(index: number, center: ParkCenter): THREE.Vector3 {
  const angle = index * GOLDEN_ANGLE;
  const r = center.maxR * PARKED_RADIUS_FRACTION + PARKED_RADIUS_PADDING;
  return new THREE.Vector3(
    center.cx + r * Math.cos(angle),
    center.y,
    center.cz + r * Math.sin(angle),
  );
}

// One step of a low-pass filter easing `current` toward `target`.
export function lowPassStep(current: number, target: number, ease: number): number {
  return current + (target - current) * ease;
}

// Low-pass smoother for the above-graph hover line, so the agents float a
// steady distance above the file graph even as the layout settles. `update` is
// fed the target height (graph top + margin), or null when there are no nodes.
export class HoverLine {
  private y = 0;
  private init = false;

  // Eases toward `target`, returning whether it's still more than REST_EPS away
  // (i.e. still needs frames). The first sample snaps and counts as a move; a
  // null target — no nodes yet — is a no-op. Rest is judged by distance to the
  // target (not by step size), so the line settles right at the target rather
  // than stalling short, and a settled line lets the render loop idle.
  update(target: number | null): boolean {
    if (target === null) return false;
    if (!this.init) {
      this.y = target;
      this.init = true;
      return true;
    }
    const moving = Math.abs(target - this.y) > REST_EPS;
    this.y = lowPassStep(this.y, target, HOVER_EASE);
    return moving;
  }

  value(): number {
    return this.y;
  }
}
