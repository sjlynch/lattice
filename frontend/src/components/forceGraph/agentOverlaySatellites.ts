// Subagent-satellite management for the Agent Presence Layer: build a satellite
// around its parent node, tear one down, and place + follow each one per frame.
// A satellite sits at a fixed golden-angle ring slot and FOLLOWS the parent — it
// never orbits for effect (perpetual motion would pin the render loop; see the
// APL idle contract). Its own focus beams + type label mirror an agent's.

import { makeSatelliteNode } from './claudeNodeSprite';
import type { AgentOverlayCtx } from './agentOverlayContext';
import {
  EASE,
  NODE_SCALE_MULTIPLIER,
  REST_EPS,
  SATELLITE_BEAM_OPACITY_FACTOR,
  SATELLITE_IDLE_TTL_MS,
  SATELLITE_SCALE,
} from './agentOverlayConstants';
import {
  createTether,
  disposeBeam,
  updateBeamEndpoints,
} from './agentOverlayBeams';
import { updateBeamGeometries } from './agentOverlayBeamMath';
import { removeFloatingLabel, updateSatelliteLabel } from './agentOverlayLabels';
import {
  freeSatelliteSlot,
  lowPassStep,
  satelliteOffset,
} from './agentOverlayPlacement';
import type { Agent, Satellite } from './agentOverlayTypes';

// Build a satellite, parking it AT the parent node so its first tick eases it
// out to its ring slot (a one-time fly-out, not perpetual motion).
export function createSatellite(
  ctx: AgentOverlayCtx,
  agent: Agent,
  subagentId: string,
  subagentType: string | undefined,
  now: number,
): Satellite {
  const slot = freeSatelliteSlot(
    [...agent.satellites.values()].map((s) => s.slot),
  );
  const size = ctx.nodeSize * NODE_SCALE_MULTIPLIER * SATELLITE_SCALE;
  const node = makeSatelliteNode(agent.color, size);
  node.position.copy(agent.pos);
  ctx.group.add(node);
  const tether = createTether(agent.color);
  ctx.group.add(tether.line);
  const off = satelliteOffset(slot, ctx.nodeSize);
  const sat: Satellite = {
    subagentId,
    subagentType,
    slot,
    color: agent.color,
    node,
    pos: agent.pos.clone(),
    offDx: off.dx,
    offDy: off.dy,
    offDz: off.dz,
    tether,
    beams: new Map(),
    lastSeen: now,
  };
  agent.satellites.set(subagentId, sat);
  return sat;
}

// Tear down a satellite's node, tether, beams, and label.
export function disposeSatellite(ctx: AgentOverlayCtx, sat: Satellite): void {
  for (const beam of sat.beams.values()) disposeBeam(ctx.group, beam);
  sat.beams.clear();
  disposeBeam(ctx.group, sat.tether);
  ctx.group.remove(sat.node);
  if (sat.label) removeFloatingLabel(ctx.group, sat);
}

// Place each of an agent's satellites at its fixed ring slot around the parent
// node and follow the parent — they never orbit for effect (perpetual motion
// would pin the render loop; see the APL idle contract). Updates the tether,
// the type label, and the satellite's own beam geometries, and idle-reaps a
// satellite whose SubagentStop was missed and has gone fully quiet. Returns
// whether any satellite still has motion to paint.
export function updateSatellites(
  ctx: AgentOverlayCtx,
  agent: Agent,
  now: number,
): boolean {
  let moving = false;
  // Iterate values() (not entries) to skip the per-satellite pair-array
  // allocation; Satellite.subagentId is the exact map key for the delete.
  // Deleting mid-values()-iteration is safe.
  for (const sat of agent.satellites.values()) {
    // Missed-SubagentStop safety net: a satellite with no live beam that has
    // been quiet past the TTL is reaped. SubagentStop is the primary signal,
    // so a satellite still showing its last file (a persistent beam) is kept.
    if (sat.beams.size === 0 && now - sat.lastSeen > SATELLITE_IDLE_TTL_MS) {
      disposeSatellite(ctx, sat);
      agent.satellites.delete(sat.subagentId);
      moving = true;
      continue;
    }
    // Cached ring offset (set at spawn, refreshed in setSizes) — no per-frame
    // trig + object allocation.
    const tx = agent.pos.x + sat.offDx;
    const ty = agent.pos.y + sat.offDy;
    const tz = agent.pos.z + sat.offDz;
    if (
      Math.abs(tx - sat.pos.x) > REST_EPS ||
      Math.abs(ty - sat.pos.y) > REST_EPS ||
      Math.abs(tz - sat.pos.z) > REST_EPS
    ) {
      moving = true;
      sat.pos.set(
        lowPassStep(sat.pos.x, tx, EASE),
        lowPassStep(sat.pos.y, ty, EASE),
        lowPassStep(sat.pos.z, tz, EASE),
      );
      sat.node.position.copy(sat.pos);
    }
    // Tether parent → satellite (constant opacity; geometry only).
    updateBeamEndpoints(sat.tether, agent.pos, sat.pos);
    // The type label is opt-in (off by default — the orb alone shows presence).
    // When toggled off at runtime, drop any label this satellite already has.
    if (ctx.showSubagentLabels) {
      updateSatelliteLabel(ctx.group, sat, ctx.labelSize, ctx.nodeSize);
    } else if (sat.label) {
      removeFloatingLabel(ctx.group, sat);
    }
    updateBeamGeometries(ctx, sat.beams, sat.pos, now, SATELLITE_BEAM_OPACITY_FACTOR);
  }
  return moving;
}
