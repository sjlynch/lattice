// The **Agent Presence Layer (APL)** façade — scene overlay for live agents
// (in-worktree task agents and non-worktree sessions). `hooks/useAgentOverlay.ts`
// is the lifecycle + render-on-demand half and owns the RAF that calls `tick`.
// Vocabulary + rules: forceGraph/CLAUDE.md → "Agent Presence Layer".
//
// A presence node per agent floats above the graph: X/Z ease toward the centroid
// of the files it's touching; Y sits on the "hover line" just above the graph
// top, low-pass filtered so it doesn't bob. Focus beams (node → touched file)
// fade on a TTL — except the LAST file viewed/edited, whose beam + label persist
// for the session so a thinking agent still shows what it touched. A stopped
// session removes node, label and beams. Nodes live in `graph.scene()`, not
// `graphData()`, so agents never reheat the sim or distort the DAG.
//
// This file holds the shared state (`AgentOverlayCtx`) and delegates to
// `agentOverlay<Name>.ts`: Context (state + scene group), Constants (tunables,
// render orders), Types, PathIndex (path normalization, path→node, bounds),
// Reconcile (registry + disposal), Activity (beam add/demote TTL policy),
// Satellites (subagents), Beams (three.js lifecycle + fade), BeamMath (per-frame
// centroid/geometry), Tick (easing/labels/beams), Labels, Placement (parked
// position + hover height).

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
  reapIdleSatellites,
} from './agentOverlaySatellites';
import { tickOverlay } from './agentOverlayTick';
import type { AgentDescriptor } from './agentOverlayTypes';

export type { AgentDescriptor } from './agentOverlayTypes';

export class AgentOverlay {
  private readonly ctx: AgentOverlayCtx;

  constructor(graph: ForceGraph3DInstance, nodeSize: number) {
    this.ctx = createAgentOverlayCtx(graph, nodeSize);
  }

  setSizes(nodeSize: number, labelSize: number, showSubagentLabels: boolean): void {
    const ctx = this.ctx;
    ctx.labelSize = labelSize;
    // Pushed every frame (before the nodeSize early-out) so a Settings toggle
    // takes effect on the next satellite update — see updateSatellites.
    ctx.showSubagentLabels = showSubagentLabels;
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
  // Returns false when the agent isn't on screen (nothing changed, so the caller
  // needn't wake the render loop).
  addActivity(
    taskId: string,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): boolean {
    const agent = this.ctx.agents.get(taskId);
    if (!agent) return false;
    applyActivity(this.ctx, agent, file, phase, now);
    return true;
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
  // never has nowhere to land. Returns false when the parent isn't on screen.
  addSubagentActivity(
    taskId: string,
    subagentId: string,
    subagentType: string | undefined,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): boolean {
    const agent = this.ctx.agents.get(taskId);
    if (!agent) return false;
    let sat = agent.satellites.get(subagentId);
    if (!sat) sat = createSatellite(this.ctx, agent, subagentId, subagentType, now);
    sat.lastSeen = now;
    if (subagentType && !sat.subagentType) sat.subagentType = subagentType;
    applyActivity(this.ctx, sat, file, phase, now);
    return true;
  }

  // Per-frame update. Returns whether the overlay still has SELF-DRIVEN motion
  // to paint (drives the idle controller's `agents` reason). See
  // agentOverlayTick for the full contract.
  tick(now: number, graph: ForceGraph3DInstance, engineHot: boolean): boolean {
    return tickOverlay(this.ctx, now, graph, engineHot);
  }

  // Dispose every satellite past its idle TTL now rather than on the next tick,
  // which never comes while the render loop is paused (hidden tab / collapsed
  // graph). Returns whether any was removed, so the caller can wake the loop to
  // paint it.
  reapSatellites(now: number): boolean {
    let reaped = false;
    for (const agent of this.ctx.agents.values()) {
      if (reapIdleSatellites(this.ctx, agent, now)) reaped = true;
    }
    return reaped;
  }

  // Whether `taskId`'s node is on screen (activity for it can land).
  hasAgent(taskId: string): boolean {
    return this.ctx.agents.has(taskId);
  }

  // True while any agent node is on screen. `useAgentOverlay` uses this only as
  // a cheap early-out (skip the per-frame work entirely when nothing is on
  // screen) — whether the loop stays awake is decided by `tick`'s return.
  isActive(): boolean {
    return this.ctx.agents.size > 0;
  }

  destroy(graph: ForceGraph3DInstance): void {
    for (const taskId of [...this.ctx.agents.keys()]) removeAgent(this.ctx, taskId);
    this.ctx.pathIndex.clear();
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.remove(this.ctx.group);
    // Dispose every agent label texture + paired material. The cache is module-
    // global (shared by the single live overlay), so this frees the whole label
    // texture/material set instead of leaking it for the page lifetime.
    disposeAgentLabelCache();
  }
}
