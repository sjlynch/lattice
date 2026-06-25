// The **Agent Presence Layer (APL)** — scene-level overlay for active Claude
// agents (both in-worktree task agents and non-worktree sessions). This file is
// the drawing/orchestration half; `hooks/useAgentOverlay.ts` is the lifecycle +
// render-on-demand half. Vocabulary: a "presence node" (one per live agent), a
// "focus beam" (node → a file it's touching, on a TTL), and the "hover line"
// (the steady height the nodes float at above the graph).
//
// Each live agent draws a free-floating "Claude node" (see claudeNodeSprite)
// that hovers ABOVE the file graph at a stable height: its X/Z ease toward
// the centroid of the files it's currently touching (so it sits over the
// region it's working in) while its Y is pinned just above the top of the
// graph and low-pass filtered so it doesn't bob. A camera-scaled label next
// to the node shows the file it's reading/editing.
//
// The LAST file an agent viewed/edited stays lit — its beam never expires and
// its label stays on screen — for the whole life of the session, so a node
// always shows what it most recently touched even while the agent is thinking.
// Older (no-longer-current) files fade out on a TTL, so several recently-
// touched files can stay lit at once, but the current one persists. When the
// session stops the agent is removed entirely (node + label + beams cleared)
// until it becomes active again.
//
// The nodes live directly in `graph.scene()` rather than `graphData()` — so
// an agent appearing/finishing never reheats the d3 simulation or distorts
// the DAG. `useAgentOverlay` owns the RAF that calls `tick`.
//
// This file is now a thin façade: it holds the shared mutable state
// (`AgentOverlayCtx`) and delegates each method to a focused sibling module so
// the public API below stays stable while the logic lives in cohesive units:
//   - agentOverlayContext.ts    — the shared mutable state + scene group
//   - agentOverlayConstants.ts  — tunables + render orders
//   - agentOverlayTypes.ts      — SimNode / Beam / Agent / AgentDescriptor
//   - agentOverlayPathIndex.ts  — path normalization, path→node index, bounds
//   - agentOverlayReconcile.ts  — live-agent reconciliation/registry + disposal
//   - agentOverlayActivity.ts   — focus-beam add/demote (TTL) policy
//   - agentOverlaySatellites.ts — subagent-satellite lifecycle + placement
//   - agentOverlayBeams.ts      — beam three.js create / dispose / geometry + fade
//   - agentOverlayBeamMath.ts   — per-frame centroid + geometry beam passes
//   - agentOverlayTick.ts       — per-frame tick math (easing / labels / beams)
//   - agentOverlayLabels.ts     — agent file-label build / update / clear
//   - agentOverlayPlacement.ts  — parked-position + hover-height math

import type * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import {
  NODE_SCALE_MULTIPLIER,
  SATELLITE_SCALE,
} from './agentOverlayConstants';
import {
  createAgentOverlayCtx,
  type AgentOverlayCtx,
} from './agentOverlayContext';
import { applyActivity } from './agentOverlayActivity';
import { disposeAgentLabelCache } from './agentOverlayLabels';
import { satelliteOffset } from './agentOverlayPlacement';
import { reconcileAgents, removeAgent } from './agentOverlayReconcile';
import {
  createSatellite,
  disposeSatellite,
} from './agentOverlaySatellites';
import { tickOverlay } from './agentOverlayTick';
import type { AgentDescriptor } from './agentOverlayTypes';

export type { AgentDescriptor } from './agentOverlayTypes';

export class AgentOverlay {
  private readonly ctx: AgentOverlayCtx;

  constructor(graph: ForceGraph3DInstance, nodeSize: number) {
    this.ctx = createAgentOverlayCtx(graph, nodeSize);
  }

  setSizes(nodeSize: number, labelSize: number): void {
    const ctx = this.ctx;
    ctx.labelSize = labelSize;
    if (nodeSize === ctx.nodeSize) return;
    ctx.nodeSize = nodeSize;
    const s = nodeSize * NODE_SCALE_MULTIPLIER;
    const ss = s * SATELLITE_SCALE;
    for (const a of ctx.agents.values()) {
      a.node.scale.set(s, s, 1);
      for (const sat of a.satellites.values()) {
        sat.node.scale.set(ss, ss, 1);
        // The cached ring offset depends on nodeSize — refresh it here, the
        // only other place nodeSize changes (besides createSatellite).
        const off = satelliteOffset(sat.slot, nodeSize);
        sat.offDx = off.dx;
        sat.offDy = off.dy;
        sat.offDz = off.dz;
      }
    }
  }

  // Reconcile the live agent set against the latest descriptors. Returns
  // whether the set visibly changed (an agent added / removed / recolored), so
  // the caller can force a repaint — a removal must paint even when the render
  // loop is otherwise idle (see useAgentOverlay's wakeForRefresh).
  setAgents(descriptors: AgentDescriptor[], graph: ForceGraph3DInstance): boolean {
    return reconcileAgents(this.ctx, descriptors, graph);
  }

  // A `task-activity` / `agent-activity` event for the MAIN agent: open/refresh
  // the beam for the touched file and record it as the agent's current file.
  addActivity(
    taskId: string,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): void {
    const agent = this.ctx.agents.get(taskId);
    if (!agent) return;
    applyActivity(this.ctx, agent, file, phase, now);
  }

  // A subagent (Task/Agent) of `taskId` spawned — show a satellite around its
  // parent node. Idempotent: a repeat refreshes liveness/type. No-op if the
  // parent isn't on screen (the parent's node must exist to hang the satellite
  // off). Returns whether a satellite was added (caller forces a repaint).
  addSubagent(
    taskId: string,
    subagentId: string,
    subagentType: string | undefined,
    now: number,
  ): boolean {
    const agent = this.ctx.agents.get(taskId);
    if (!agent) return false;
    const existing = agent.satellites.get(subagentId);
    if (existing) {
      existing.lastSeen = now;
      if (subagentType) existing.subagentType = subagentType;
      return false;
    }
    createSatellite(this.ctx, agent, subagentId, subagentType, now);
    return true;
  }

  // A subagent finished (SubagentStop) — remove its satellite. Returns whether
  // one was actually removed (caller forces a repaint of the deletion).
  removeSubagent(taskId: string, subagentId: string): boolean {
    const agent = this.ctx.agents.get(taskId);
    if (!agent) return false;
    const sat = agent.satellites.get(subagentId);
    if (!sat) return false;
    disposeSatellite(this.ctx, sat);
    agent.satellites.delete(subagentId);
    return true;
  }

  // A subagent's own tool-use: beam from its satellite to the touched file.
  // Lazily creates the satellite if its SubagentStart was missed, so a beam
  // never has nowhere to land.
  addSubagentActivity(
    taskId: string,
    subagentId: string,
    subagentType: string | undefined,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): void {
    const agent = this.ctx.agents.get(taskId);
    if (!agent) return;
    let sat = agent.satellites.get(subagentId);
    if (!sat) sat = createSatellite(this.ctx, agent, subagentId, subagentType, now);
    sat.lastSeen = now;
    if (subagentType && !sat.subagentType) sat.subagentType = subagentType;
    applyActivity(this.ctx, sat, file, phase, now);
  }

  // Per-frame update. Returns whether the overlay still has SELF-DRIVEN motion
  // to paint (drives the idle controller's `agents` reason). See
  // agentOverlayTick for the full contract.
  tick(now: number, graph: ForceGraph3DInstance, engineHot: boolean): boolean {
    return tickOverlay(this.ctx, now, graph, engineHot);
  }

  // True while any agent node is on screen. `useAgentOverlay` uses this only as
  // a cheap early-out (skip the per-frame work entirely when nothing is on
  // screen) — whether the loop stays awake is decided by `tick`'s return.
  isActive(): boolean {
    return this.ctx.agents.size > 0;
  }

  destroy(graph: ForceGraph3DInstance): void {
    for (const taskId of [...this.ctx.agents.keys()]) removeAgent(this.ctx, taskId);
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.remove(this.ctx.group);
    // Dispose every agent label texture + paired material. The cache is module-
    // global (shared by the single live overlay), so this frees the whole label
    // texture/material set instead of leaking it for the page lifetime.
    disposeAgentLabelCache();
  }
}
