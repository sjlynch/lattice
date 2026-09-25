// Per-frame tick math for the Agent Presence Layer: refresh the hover line, ease
// each agent toward the centroid of the files it's touching, update labels +
// beams, and place the satellites. Returns whether the overlay still has
// SELF-DRIVEN motion to paint (drives the idle controller's `agents` reason).
// The beam centroid/geometry passes live in agentOverlayBeamMath.ts; satellite
// placement in agentOverlaySatellites.ts; this module owns the frame loop and
// the agent node easing.

import type { ForceGraph3DInstance } from '3d-force-graph';
import type { AgentOverlayCtx } from './agentOverlayContext';
import {
  BOUNDS_RECHECK_FRAMES,
  EASE,
  HOVER_EASE,
  REST_EPS,
} from './agentOverlayConstants';
import { accumulateBeams, updateBeamGeometries } from './agentOverlayBeamMath';
import { clearAgentLabel, updateAgentLabel } from './agentOverlayLabels';
import { layoutAgentLabels } from './agentOverlayLabelLayout';
import { hoverMargin } from './agentOverlayPathIndex';
import { lowPassStep } from './agentOverlayPlacement';
import { updateSatellites } from './agentOverlaySatellites';
import type { Agent } from './agentOverlayTypes';

// Low-pass the hover line toward (graph top + margin) so the agents float a
// steady distance above the file graph even as the layout settles. Returns
// whether the line still moved this frame (propagated into tick's "moving").
function updateHoverY(ctx: AgentOverlayCtx): boolean {
  const bounds = ctx.pathIndex.bounds();
  return ctx.hoverLine.update(bounds ? bounds.maxY + hoverMargin(bounds) : null);
}

// Advance a single agent for this frame and return whether it still has
// self-driven motion to paint (centroid easing, satellite easing, or a beam
// fading). Split out of `tick`'s per-agent loop so each documented Part A/B/D
// perf invariant is individually readable. The five concerns run in order:
// centroid accumulation (Part A), X/Z + Y easing under the REST_EPS gate
// (Part B), label show/clear, beam-geometry update (Part D), and satellite
// placement. Uses the shared `ctx.acc` accumulator, reset at the top here —
// safe because `tick` is not re-entrant, so one agent is processed at a time.
function tickAgent(
  ctx: AgentOverlayCtx,
  agent: Agent,
  now: number,
  hoverY: number,
): boolean {
  let moving = false;

  // Gather live beam targets (X/Z only — Y is the hover line). Includes the
  // main agent's beams AND its subagents' beams, so the node centers over the
  // whole cluster's work even when the main agent has delegated. This pass also
  // prunes expired beams and stashes each live beam's file node for the geometry
  // pass below (Part D).
  const acc = ctx.acc;
  acc.sx = 0;
  acc.sz = 0;
  acc.n = 0;
  if (accumulateBeams(ctx, agent.beams, now, acc)) moving = true;
  if (agent.satellites.size > 0) {
    for (const sat of agent.satellites.values()) {
      if (accumulateBeams(ctx, sat.beams, now, acc)) moving = true;
    }
  }

  // Track horizontally toward the files in play; keep X/Z when idle. Rest is
  // judged by distance to the target (not by easing step), so the node settles
  // right over its files instead of stalling a few units short.
  const tx = acc.n > 0 ? acc.sx / acc.n : agent.pos.x;
  const tz = acc.n > 0 ? acc.sz / acc.n : agent.pos.z;
  // Ease + push to the node sprite only while it's still more than REST_EPS from
  // its target (the same criterion that drives `moving`). Once within REST_EPS
  // it's at rest: skip the easing AND the node.position.copy, so a settled node
  // doesn't re-dirty its matrix every frame while the loop runs for some other
  // reason (Part B). The residual (< REST_EPS) is sub-pixel — the same settle
  // tolerance the loop already idles at.
  if (
    Math.abs(tx - agent.pos.x) > REST_EPS ||
    Math.abs(tz - agent.pos.z) > REST_EPS ||
    Math.abs(hoverY - agent.pos.y) > REST_EPS
  ) {
    moving = true;
    agent.pos.set(
      lowPassStep(agent.pos.x, tx, EASE),
      lowPassStep(agent.pos.y, hoverY, HOVER_EASE),
      lowPassStep(agent.pos.z, tz, EASE),
    );
    agent.node.position.copy(agent.pos);
  }

  // Show the last file the agent viewed/edited for as long as the session is
  // alive — the label persists through idle gaps and only clears when the agent
  // is removed (session stopped). Before the first activity there's no file yet,
  // so nothing is shown.
  if (agent.currentFile) {
    updateAgentLabel(ctx.group, agent, ctx.labelSize, ctx.nodeSize);
  } else {
    clearAgentLabel(ctx.group, agent);
  }

  // Update the main agent's beam geometries + opacity (reusing the stashed file
  // nodes), then place + update its satellites.
  updateBeamGeometries(ctx, agent.beams, agent.pos, now, 1);
  if (agent.satellites.size > 0 && updateSatellites(ctx, agent, now)) moving = true;

  return moving;
}

// Per-frame update: refresh the hover line, ease nodes, update labels + beams,
// prune expired beams.
//
// Returns whether the overlay still has SELF-DRIVEN motion to paint — a node is
// still easing, the hover line is still settling, or a beam is fading.
// `useAgentOverlay` uses this to hold the idle controller's `agents` reason only
// while that's true, so an idle (settled) agent lets the render loop suspend
// instead of pinning it at 60fps. Beam endpoints tracking a *moving* file node
// don't need to be reported here: while the d3 engine is hot the loop already
// runs on its own `engine` reason and this still gets called each render frame
// (via scene.onBeforeRender), so the beams follow for free; once the engine
// settles the file nodes stop and there's nothing left to track.
//
// `engineHot` says whether the d3 layout is live this frame; when it is, the
// cached graph bounds are invalidated so the hover line tracks the still-moving
// nodes, otherwise the cache is reused (the bounds scan is O(N)).
export function tickOverlay(
  ctx: AgentOverlayCtx,
  now: number,
  graph: ForceGraph3DInstance,
  engineHot: boolean,
): boolean {
  if (ctx.agents.size === 0) return false;
  ctx.pathIndex.ensure(graph);
  if (engineHot || ++ctx.sinceBoundsRecheck >= BOUNDS_RECHECK_FRAMES) {
    ctx.pathIndex.invalidateBounds();
    ctx.sinceBoundsRecheck = 0;
  }
  let moving = updateHoverY(ctx);
  const hoverY = ctx.hoverLine.value();

  for (const agent of ctx.agents.values()) {
    if (tickAgent(ctx, agent, now, hoverY)) moving = true;
  }
  // Once every label's text/size is current, spread them in screen space so a
  // parent's and its subagents' file labels never overlap (a snap, not an
  // animation — contributes nothing to `moving`).
  layoutAgentLabels(ctx, graph);

  return moving;
}
