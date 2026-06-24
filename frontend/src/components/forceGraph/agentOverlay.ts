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
// This file is the orchestrator; cohesive internals live alongside it:
//   - agentOverlayConstants.ts — tunables + render orders
//   - agentOverlayTypes.ts      — SimNode / Beam / Agent / AgentDescriptor
//   - agentOverlayPathIndex.ts  — path normalization, path→node index, bounds
//   - agentOverlayBeams.ts      — beam create / dispose / geometry + fade
//   - agentOverlayLabels.ts     — agent file-label build / update / clear
//   - agentOverlayPlacement.ts  — parked-position + hover-height math

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { makeClaudeNode, makeSatelliteNode } from './claudeNodeSprite';
import {
  AGENT_GROUP_RENDER_ORDER,
  BEAM_END_FADE_MS,
  BEAM_TTL_MS,
  BOUNDS_RECHECK_FRAMES,
  EASE,
  HOVER_EASE,
  NODE_SCALE_MULTIPLIER,
  PARKED_BASE_RADIUS,
  REST_EPS,
  SATELLITE_BEAM_OPACITY_FACTOR,
  SATELLITE_IDLE_TTL_MS,
  SATELLITE_SCALE,
} from './agentOverlayConstants';
import {
  AgentPathIndex,
  baseName,
  hoverMargin,
  normalizePath,
} from './agentOverlayPathIndex';
import {
  createBeam,
  createTether,
  disposeBeam,
  updateBeam,
  updateBeamEndpoints,
} from './agentOverlayBeams';
import {
  clearAgentLabel,
  updateAgentLabel,
  updateSatelliteLabel,
} from './agentOverlayLabels';
import {
  freeSatelliteSlot,
  HoverLine,
  lowPassStep,
  parkedPosition,
  satelliteOffset,
} from './agentOverlayPlacement';
import type {
  Agent,
  AgentDescriptor,
  Beam,
  Satellite,
} from './agentOverlayTypes';

// The beam-bearing fields shared by an Agent and a Satellite, so the focus-beam
// add/demote policy (`applyActivity`) works on either.
type BeamHost = {
  color: string;
  beams: Map<string, Beam>;
  currentFile?: string;
  // Cached basename of currentFile (kept in lock-step at the write site below).
  currentFileBase?: string;
};

export type { AgentDescriptor } from './agentOverlayTypes';

export class AgentOverlay {
  private group = new THREE.Group();
  private agents = new Map<string, Agent>();
  private pathIndex = new AgentPathIndex();
  private nodeSize: number;
  // Base height for the file label, kept in sync with the graph's labelSize
  // (same as the Alt-label overlay) so agent labels read at the same scale as
  // file labels. Default mirrors graphSettings until the first tick sets it.
  private labelSize = 3.0;
  private spawnCount = 0;
  // Smoothed Y of the hover line (above the graph top). Computed from live
  // node positions, low-pass filtered so the agents' height stays steady.
  private hoverLine = new HoverLine();
  private readonly tmpB = new THREE.Vector3();
  // Reusable per-agent centroid accumulator, reset at the top of each agent
  // iteration in tick (tick is not re-entrant, so a single shared instance is
  // safe). Hoisted off the per-agent-per-frame object literal it replaced.
  private readonly acc = { sx: 0, sz: 0, n: 0 };
  // Frames since the cached graph bounds were last recomputed (see
  // BOUNDS_RECHECK_FRAMES). Forces a periodic refresh so the hover line can't
  // lag node motion that bypasses the engine-hot flag.
  private sinceBoundsRecheck = 0;

  constructor(graph: ForceGraph3DInstance, nodeSize: number) {
    this.nodeSize = nodeSize;
    this.group.renderOrder = AGENT_GROUP_RENDER_ORDER;
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.add(this.group);
  }

  setSizes(nodeSize: number, labelSize: number): void {
    this.labelSize = labelSize;
    if (nodeSize === this.nodeSize) return;
    this.nodeSize = nodeSize;
    const s = nodeSize * NODE_SCALE_MULTIPLIER;
    const ss = s * SATELLITE_SCALE;
    for (const a of this.agents.values()) {
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
    let changed = false;
    const wanted = new Map(descriptors.map((d) => [d.taskId, d]));
    for (const taskId of [...this.agents.keys()]) {
      if (!wanted.has(taskId)) {
        this.removeAgent(taskId);
        changed = true;
      }
    }
    for (const d of descriptors) {
      const existing = this.agents.get(d.taskId);
      if (!existing) {
        this.addAgent(d, graph);
        changed = true;
      } else if (existing.color !== d.color) {
        // Color slot changed (rare) — rebuild the node sprite.
        this.group.remove(existing.node);
        existing.color = d.color;
        existing.node = makeClaudeNode(d.color, this.nodeSize * NODE_SCALE_MULTIPLIER);
        existing.node.position.copy(existing.pos);
        this.group.add(existing.node);
        // Recolor satellites + tethers to match (existing beams age out in the
        // old color; new ones pick up the new color).
        const ss = this.nodeSize * NODE_SCALE_MULTIPLIER * SATELLITE_SCALE;
        for (const sat of existing.satellites.values()) {
          sat.color = d.color;
          this.group.remove(sat.node);
          sat.node = makeSatelliteNode(d.color, ss);
          sat.node.position.copy(sat.pos);
          this.group.add(sat.node);
          sat.tether.material.color.set(d.color);
        }
        changed = true;
      }
    }
    return changed;
  }

  private addAgent(d: AgentDescriptor, graph: ForceGraph3DInstance): void {
    this.pathIndex.ensure(graph);
    const pos = this.parkedPosition(this.spawnCount++);
    const node = makeClaudeNode(d.color, this.nodeSize * NODE_SCALE_MULTIPLIER);
    node.position.copy(pos);
    this.group.add(node);
    this.agents.set(d.taskId, {
      taskId: d.taskId,
      color: d.color,
      node,
      pos,
      beams: new Map(),
      satellites: new Map(),
    });
  }

  private removeAgent(taskId: string): void {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    for (const beam of agent.beams.values()) disposeBeam(this.group, beam);
    agent.beams.clear();
    for (const sat of agent.satellites.values()) this.disposeSatellite(sat);
    agent.satellites.clear();
    this.group.remove(agent.node);
    if (agent.label) this.group.remove(agent.label);
    this.agents.delete(taskId);
  }

  // Tear down a satellite's node, tether, beams, and label.
  private disposeSatellite(sat: Satellite): void {
    for (const beam of sat.beams.values()) disposeBeam(this.group, beam);
    sat.beams.clear();
    disposeBeam(this.group, sat.tether);
    this.group.remove(sat.node);
    if (sat.label) this.group.remove(sat.label);
  }

  // A `task-activity` / `agent-activity` event for the MAIN agent: open/refresh
  // the beam for the touched file and record it as the agent's current file.
  addActivity(
    taskId: string,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): void {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    this.applyActivity(agent, file, phase, now);
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
    const agent = this.agents.get(taskId);
    if (!agent) return false;
    const existing = agent.satellites.get(subagentId);
    if (existing) {
      existing.lastSeen = now;
      if (subagentType) existing.subagentType = subagentType;
      return false;
    }
    this.createSatellite(agent, subagentId, subagentType, now);
    return true;
  }

  // A subagent finished (SubagentStop) — remove its satellite. Returns whether
  // one was actually removed (caller forces a repaint of the deletion).
  removeSubagent(taskId: string, subagentId: string): boolean {
    const agent = this.agents.get(taskId);
    if (!agent) return false;
    const sat = agent.satellites.get(subagentId);
    if (!sat) return false;
    this.disposeSatellite(sat);
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
    const agent = this.agents.get(taskId);
    if (!agent) return;
    let sat = agent.satellites.get(subagentId);
    if (!sat) sat = this.createSatellite(agent, subagentId, subagentType, now);
    sat.lastSeen = now;
    if (subagentType && !sat.subagentType) sat.subagentType = subagentType;
    this.applyActivity(sat, file, phase, now);
  }

  // Build a satellite, parking it AT the parent node so its first tick eases it
  // out to its ring slot (a one-time fly-out, not perpetual motion).
  private createSatellite(
    agent: Agent,
    subagentId: string,
    subagentType: string | undefined,
    now: number,
  ): Satellite {
    const slot = freeSatelliteSlot(
      [...agent.satellites.values()].map((s) => s.slot),
    );
    const size = this.nodeSize * NODE_SCALE_MULTIPLIER * SATELLITE_SCALE;
    const node = makeSatelliteNode(agent.color, size);
    node.position.copy(agent.pos);
    this.group.add(node);
    const tether = createTether(agent.color);
    this.group.add(tether.line);
    const off = satelliteOffset(slot, this.nodeSize);
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

  // Focus-beam add/demote policy, shared by the main agent and its satellites.
  // The current file's beam is kept persistent (`endAt = Infinity`) so the last
  // file the host viewed/edited stays lit until either a *new* file is touched
  // (demoting the old one to a fading TTL beam) or the host is removed. A
  // PostToolUse (`end`) for the current file does NOT fade it.
  private applyActivity(
    host: BeamHost,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): void {
    const norm = normalizePath(file);
    const prevNorm = host.currentFile ? normalizePath(host.currentFile) : null;

    if (phase === 'end') {
      // Tool finished. Keep the current (last-touched) file lit; only let an
      // older, no-longer-current file begin to fade.
      const existing = host.beams.get(norm);
      if (existing && norm !== prevNorm) {
        existing.endAt = Math.min(existing.endAt, now + BEAM_END_FADE_MS);
      }
      return;
    }

    // phase === 'start': this file becomes the host's current file. Demote the
    // previously-current file's beam to a normal fading one.
    if (prevNorm && prevNorm !== norm) {
      const prevBeam = host.beams.get(prevNorm);
      if (prevBeam) prevBeam.endAt = now + BEAM_TTL_MS;
    }
    host.currentFile = file;
    host.currentFileBase = baseName(file);

    const existing = host.beams.get(norm);
    if (existing) {
      existing.endAt = Infinity;
      return;
    }
    const beam = createBeam(host.color, norm, now);
    host.beams.set(norm, beam);
    this.group.add(beam.line);
  }

  // Per-frame update: refresh the hover line, ease nodes, update labels +
  // beams, prune expired beams.
  //
  // Returns whether the overlay still has SELF-DRIVEN motion to paint — a node
  // is still easing, the hover line is still settling, or a beam is fading.
  // `useAgentOverlay` uses this to hold the idle controller's `agents` reason
  // only while that's true, so an idle (settled) agent lets the render loop
  // suspend instead of pinning it at 60fps. Beam endpoints tracking a *moving*
  // file node don't need to be reported here: while the d3 engine is hot the
  // loop already runs on its own `engine` reason and this still gets called each
  // render frame (via scene.onBeforeRender), so the beams follow for free; once
  // the engine settles the file nodes stop and there's nothing left to track.
  //
  // `engineHot` says whether the d3 layout is live this frame; when it is, the
  // cached graph bounds are invalidated so the hover line tracks the still-
  // moving nodes, otherwise the cache is reused (the bounds scan is O(N)).
  tick(now: number, graph: ForceGraph3DInstance, engineHot: boolean): boolean {
    if (this.agents.size === 0) return false;
    this.pathIndex.ensure(graph);
    if (engineHot || ++this.sinceBoundsRecheck >= BOUNDS_RECHECK_FRAMES) {
      this.pathIndex.invalidateBounds();
      this.sinceBoundsRecheck = 0;
    }
    let moving = this.updateHoverY();
    const hoverY = this.hoverLine.value();

    for (const agent of this.agents.values()) {
      if (this.tickAgent(agent, now, hoverY)) moving = true;
    }

    return moving;
  }

  // Advance a single agent for this frame and return whether it still has
  // self-driven motion to paint (centroid easing, satellite easing, or a beam
  // fading). Split out of `tick`'s per-agent loop so each documented Part A/B/D
  // perf invariant is individually readable. The five concerns run in order:
  // centroid accumulation (Part A), X/Z + Y easing under the REST_EPS gate
  // (Part B), label show/clear, beam-geometry update (Part D), and satellite
  // placement. Uses the shared `this.acc` accumulator, reset at the top here —
  // safe because `tick` is not re-entrant, so one agent is processed at a time.
  private tickAgent(agent: Agent, now: number, hoverY: number): boolean {
    let moving = false;

    // Gather live beam targets (X/Z only — Y is the hover line). Includes the
    // main agent's beams AND its subagents' beams, so the node centers over
    // the whole cluster's work even when the main agent has delegated. This
    // pass also prunes expired beams and stashes each live beam's file node
    // for the geometry pass below (Part D).
    const acc = this.acc;
    acc.sx = 0;
    acc.sz = 0;
    acc.n = 0;
    if (this.accumulateBeams(agent.beams, now, acc)) moving = true;
    if (agent.satellites.size > 0) {
      for (const sat of agent.satellites.values()) {
        if (this.accumulateBeams(sat.beams, now, acc)) moving = true;
      }
    }

    // Track horizontally toward the files in play; keep X/Z when idle. Rest is
    // judged by distance to the target (not by easing step), so the node
    // settles right over its files instead of stalling a few units short.
    const tx = acc.n > 0 ? acc.sx / acc.n : agent.pos.x;
    const tz = acc.n > 0 ? acc.sz / acc.n : agent.pos.z;
    // Ease + push to the node sprite only while it's still more than REST_EPS
    // from its target (the same criterion that drives `moving`). Once within
    // REST_EPS it's at rest: skip the easing AND the node.position.copy, so a
    // settled node doesn't re-dirty its matrix every frame while the loop runs
    // for some other reason (Part B). The residual (< REST_EPS) is sub-pixel —
    // the same settle tolerance the loop already idles at.
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

    // Show the last file the agent viewed/edited for as long as the session
    // is alive — the label persists through idle gaps and only clears when
    // the agent is removed (session stopped). Before the first activity
    // there's no file yet, so nothing is shown.
    if (agent.currentFile) {
      updateAgentLabel(this.group, agent, this.labelSize, this.nodeSize);
    } else {
      clearAgentLabel(this.group, agent);
    }

    // Update the main agent's beam geometries + opacity (reusing the stashed
    // file nodes), then place + update its satellites.
    this.updateBeamGeometries(agent.beams, agent.pos, now, 1);
    if (agent.satellites.size > 0 && this.updateSatellites(agent, now)) moving = true;

    return moving;
  }

  // True while any agent node is on screen. `useAgentOverlay` uses this only as
  // a cheap early-out (skip the per-frame work entirely when nothing is on
  // screen) — whether the loop stays awake is decided by `tick`'s return.
  isActive(): boolean {
    return this.agents.size > 0;
  }

  destroy(graph: ForceGraph3DInstance): void {
    for (const taskId of [...this.agents.keys()]) this.removeAgent(taskId);
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.remove(this.group);
  }

  // Prune expired beams, resolve+stash each live beam's file node (Part D), and
  // add its X/Z to the centroid accumulator. Returns whether any beam still
  // needs frames — one vanished this frame, or one is on its fade-out clock (a
  // persistent Infinity beam at rest needs nothing). Shared by the main agent
  // and each satellite.
  private accumulateBeams(
    beams: Map<string, Beam>,
    now: number,
    acc: { sx: number; sz: number; n: number },
  ): boolean {
    let moving = false;
    // Iterate values() (not entries) so destructuring a Map pair array per beam
    // per frame is avoided; Beam.normPath is the exact map key for the delete
    // and the pathIndex lookup. Deleting mid-values()-iteration is safe.
    for (const beam of beams.values()) {
      if (now >= beam.endAt) {
        disposeBeam(this.group, beam);
        beams.delete(beam.normPath);
        moving = true; // a beam vanished this frame — paint its removal
        continue;
      }
      if (beam.endAt !== Infinity) moving = true;
      const node = this.pathIndex.get(beam.normPath);
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
  private updateBeamGeometries(
    beams: Map<string, Beam>,
    origin: THREE.Vector3,
    now: number,
    opacityFactor: number,
  ): void {
    for (const beam of beams.values()) {
      const node = beam.targetNode;
      if (node) {
        this.tmpB.set(node.x ?? origin.x, node.y ?? origin.y, node.z ?? origin.z);
      } else {
        this.tmpB.copy(origin);
      }
      updateBeam(beam, origin, this.tmpB, now, opacityFactor);
    }
  }

  // Place each of an agent's satellites at its fixed ring slot around the parent
  // node and follow the parent — they never orbit for effect (perpetual motion
  // would pin the render loop; see the APL idle contract). Updates the tether,
  // the type label, and the satellite's own beam geometries, and idle-reaps a
  // satellite whose SubagentStop was missed and has gone fully quiet. Returns
  // whether any satellite still has motion to paint.
  private updateSatellites(agent: Agent, now: number): boolean {
    let moving = false;
    // Iterate values() (not entries) to skip the per-satellite pair-array
    // allocation; Satellite.subagentId is the exact map key for the delete.
    // Deleting mid-values()-iteration is safe.
    for (const sat of agent.satellites.values()) {
      // Missed-SubagentStop safety net: a satellite with no live beam that has
      // been quiet past the TTL is reaped. SubagentStop is the primary signal,
      // so a satellite still showing its last file (a persistent beam) is kept.
      if (sat.beams.size === 0 && now - sat.lastSeen > SATELLITE_IDLE_TTL_MS) {
        this.disposeSatellite(sat);
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
      updateSatelliteLabel(this.group, sat, this.labelSize, this.nodeSize);
      this.updateBeamGeometries(sat.beams, sat.pos, now, SATELLITE_BEAM_OPACITY_FACTOR);
    }
    return moving;
  }

  // Low-pass the hover line toward (graph top + margin) so the agents float a
  // steady distance above the file graph even as the layout settles. Returns
  // whether the line still moved this frame (propagated into tick's "moving").
  private updateHoverY(): boolean {
    const bounds = this.pathIndex.bounds();
    return this.hoverLine.update(bounds ? bounds.maxY + hoverMargin(bounds) : null);
  }

  // A stable spot on the hover line (above the graph) for a freshly spawned
  // agent with no activity yet — spread around the graph centroid by index.
  private parkedPosition(index: number): THREE.Vector3 {
    const bounds = this.pathIndex.bounds();
    const spread = this.pathIndex.centroidSpread();
    return parkedPosition(index, {
      cx: spread?.cx ?? 0,
      cz: spread?.cz ?? 0,
      maxR: spread?.maxR ?? PARKED_BASE_RADIUS,
      y: bounds ? bounds.maxY + hoverMargin(bounds) : 0,
    });
  }
}
