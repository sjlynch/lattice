// Per-frame focus-beam math for the Agent Presence Layer: the centroid-pass
// accumulation (which also prunes expired beams and stashes each live beam's
// file node) and the geometry-pass update (which reuses the stashed node). The
// beam *lifecycle* (create/dispose/endpoint upload + fade) lives in
// agentOverlayBeams.ts; the current-vs-fading TTL *policy* lives in
// agentOverlayActivity.ts. This module is just the two hot per-frame passes,
// shared by the main agent (agentOverlayTick) and its satellites
// (agentOverlaySatellites).

import type * as THREE from 'three';
import type { AgentOverlayCtx } from './agentOverlayContext';
import { disposeBeam, updateBeam } from './agentOverlayBeams';
import type { Beam } from './agentOverlayTypes';

// Prune expired beams, resolve+stash each live beam's file node (Part D), and
// add its X/Z to the centroid accumulator. Returns whether any beam still needs
// frames — one vanished this frame, or one is on its fade-out clock (a
// persistent Infinity beam at rest needs nothing). Shared by the main agent and
// each satellite.
export function accumulateBeams(
  ctx: AgentOverlayCtx,
  beams: Map<string, Beam>,
  now: number,
  acc: { sx: number; sz: number; n: number },
): boolean {
  let moving = false;
  // Iterate values() (not entries) so destructuring a Map pair array per beam
  // per frame is avoided; Beam.normPath is the exact map key for the delete and
  // the pathIndex lookup. Deleting mid-values()-iteration is safe.
  for (const beam of beams.values()) {
    if (now >= beam.endAt) {
      disposeBeam(ctx.group, beam);
      beams.delete(beam.normPath);
      moving = true; // a beam vanished this frame — paint its removal
      continue;
    }
    if (beam.endAt !== Infinity) moving = true;
    const node = ctx.pathIndex.get(beam.normPath);
    beam.targetNode = node;
    if (node) {
      acc.sx += node.x ?? 0;
      acc.sz += node.z ?? 0;
      acc.n++;
    }
  }
  return moving;
}

// Refresh a beam map's geometry + opacity from `origin` to each beam's stashed
// file node (Part D — no second pathIndex lookup). `opacityFactor` dims
// satellite beams under the parent's.
export function updateBeamGeometries(
  ctx: AgentOverlayCtx,
  beams: Map<string, Beam>,
  origin: THREE.Vector3,
  now: number,
  opacityFactor: number,
): void {
  for (const beam of beams.values()) {
    const node = beam.targetNode;
    if (node) {
      ctx.tmpB.set(node.x ?? origin.x, node.y ?? origin.y, node.z ?? origin.z);
    } else {
      ctx.tmpB.copy(origin);
    }
    updateBeam(beam, origin, ctx.tmpB, now, opacityFactor);
  }
}
