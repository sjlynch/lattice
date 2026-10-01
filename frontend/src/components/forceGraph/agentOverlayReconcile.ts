// Live-agent reconciliation/registry for the Agent Presence Layer: diff the
// latest descriptors against the on-screen agents, adding/removing/recoloring
// nodes (and their satellites + tethers) to match. Also owns the parked-spawn
// placement of a freshly-added agent and the per-agent teardown reused by
// `destroy`.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { makeClaudeNode, makeSatelliteNode } from './claudeNodeSprite';
import type { AgentOverlayCtx } from './agentOverlayContext';
import {
  NODE_SCALE_MULTIPLIER,
  PARKED_BASE_RADIUS,
  SATELLITE_SCALE,
} from './agentOverlayConstants';
import { disposeBeam } from './agentOverlayBeams';
import { removeFloatingLabel } from './agentOverlayLabels';
import { hoverMargin } from './agentOverlayPathIndex';
import { parkedPosition } from './agentOverlayPlacement';
import { disposeSatellite } from './agentOverlaySatellites';
import type { AgentDescriptor } from './agentOverlayTypes';

// A stable spot on the hover line (above the graph) for a freshly spawned agent
// with no activity yet — spread around the graph centroid by index.
function parkedHoverPosition(ctx: AgentOverlayCtx, index: number): THREE.Vector3 {
  const bounds = ctx.pathIndex.bounds();
  const spread = ctx.pathIndex.centroidSpread();
  return parkedPosition(index, {
    cx: spread?.cx ?? 0,
    cz: spread?.cz ?? 0,
    maxR: spread?.maxR ?? PARKED_BASE_RADIUS,
    y: bounds ? bounds.maxY + hoverMargin(bounds) : 0,
  });
}

function addAgent(
  ctx: AgentOverlayCtx,
  d: AgentDescriptor,
  graph: ForceGraph3DInstance,
): void {
  ctx.pathIndex.ensure(graph);
  const pos = parkedHoverPosition(ctx, ctx.spawnCount++);
  const node = makeClaudeNode(d.color, ctx.nodeSize * NODE_SCALE_MULTIPLIER);
  node.position.copy(pos);
  ctx.group.add(node);
  ctx.agents.set(d.taskId, {
    taskId: d.taskId,
    color: d.color,
    node,
    pos,
    beams: new Map(),
    satellites: new Map(),
  });
}

export function removeAgent(ctx: AgentOverlayCtx, taskId: string): void {
  const agent = ctx.agents.get(taskId);
  if (!agent) return;
  for (const beam of agent.beams.values()) disposeBeam(ctx.group, beam);
  agent.beams.clear();
  for (const sat of agent.satellites.values()) disposeSatellite(ctx, sat);
  agent.satellites.clear();
  ctx.group.remove(agent.node);
  // Release the label texture (not just remove the sprite) so the cache can
  // reclaim it once the session is gone.
  if (agent.label) removeFloatingLabel(ctx.group, agent);
  ctx.agents.delete(taskId);
  if (ctx.agents.size === 0) ctx.pathIndex.clear();
}

// Reconcile the live agent set against the latest descriptors. Returns whether
// the set visibly changed (an agent added / removed / recolored), so the caller
// can force a repaint — a removal must paint even when the render loop is
// otherwise idle (see useAgentOverlay's wakeForRefresh).
export function reconcileAgents(
  ctx: AgentOverlayCtx,
  descriptors: AgentDescriptor[],
  graph: ForceGraph3DInstance,
): boolean {
  let changed = false;
  const wanted = new Map(descriptors.map((d) => [d.taskId, d]));
  for (const taskId of [...ctx.agents.keys()]) {
    if (!wanted.has(taskId)) {
      removeAgent(ctx, taskId);
      changed = true;
    }
  }
  for (const d of descriptors) {
    const existing = ctx.agents.get(d.taskId);
    if (!existing) {
      addAgent(ctx, d, graph);
      changed = true;
    } else if (existing.color !== d.color) {
      // Color slot changed (rare) — rebuild the node sprite.
      ctx.group.remove(existing.node);
      existing.color = d.color;
      existing.node = makeClaudeNode(d.color, ctx.nodeSize * NODE_SCALE_MULTIPLIER);
      existing.node.position.copy(existing.pos);
      ctx.group.add(existing.node);
      // The label texture is baked with the agent color at build time and is only
      // rebuilt on a text/labelSize change — never on a recolor. Drop it (refcount
      // released, currentFile untouched) so the next tick's updateAgentLabel
      // rebuilds it in the new color instead of leaving it stuck in the old one.
      if (existing.label) removeFloatingLabel(ctx.group, existing);
      // Recolor the beams in place too (each owns its material). Fading beams
      // would age out, but the persistent current-file beam never does — an
      // idle agent kept an old-color beam beside its new-color node.
      for (const beam of existing.beams.values()) beam.material.color.set(d.color);
      // Recolor satellites, tethers and their beams to match.
      const ss = ctx.nodeSize * NODE_SCALE_MULTIPLIER * SATELLITE_SCALE;
      for (const sat of existing.satellites.values()) {
        sat.color = d.color;
        ctx.group.remove(sat.node);
        sat.node = makeSatelliteNode(d.color, ss);
        sat.node.position.copy(sat.pos);
        ctx.group.add(sat.node);
        sat.tether.material.color.set(d.color);
        for (const beam of sat.beams.values()) beam.material.color.set(d.color);
        // Same baked-color label issue for the satellite's type label.
        if (sat.label) removeFloatingLabel(ctx.group, sat);
      }
      changed = true;
    }
  }
  // Also enforce ownership for an already-empty reconciliation, without waiting
  // for a render frame or indexing a graph that no agent uses.
  if (ctx.agents.size === 0) ctx.pathIndex.clear();
  return changed;
}
