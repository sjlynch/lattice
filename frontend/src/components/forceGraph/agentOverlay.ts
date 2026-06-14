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
import { makeClaudeNode } from './claudeNodeSprite';
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
} from './agentOverlayConstants';
import {
  AgentPathIndex,
  hoverMargin,
  normalizePath,
} from './agentOverlayPathIndex';
import { createBeam, disposeBeam, updateBeam } from './agentOverlayBeams';
import { clearAgentLabel, updateAgentLabel } from './agentOverlayLabels';
import { HoverLine, lowPassStep, parkedPosition } from './agentOverlayPlacement';
import type { Agent, AgentDescriptor } from './agentOverlayTypes';

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
    for (const a of this.agents.values()) a.node.scale.set(s, s, 1);
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
    });
  }

  private removeAgent(taskId: string): void {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    for (const beam of agent.beams.values()) disposeBeam(this.group, beam);
    agent.beams.clear();
    this.group.remove(agent.node);
    if (agent.label) this.group.remove(agent.label);
    this.agents.delete(taskId);
  }

  // A `task-activity` / `agent-activity` event: open/refresh the beam for the
  // touched file and record it as the agent's current file. The current file's
  // beam is kept persistent (`endAt = Infinity`) so the last file the agent
  // viewed/edited stays lit — and its label stays up — until either a *new*
  // file is touched (demoting the old one to a fading TTL beam) or the session
  // stops. A PostToolUse (`end`) for the current file does NOT fade it.
  addActivity(
    taskId: string,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): void {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    const norm = normalizePath(file);
    const prevNorm = agent.currentFile ? normalizePath(agent.currentFile) : null;

    if (phase === 'end') {
      // Tool finished. Keep the current (last-touched) file lit; only let an
      // older, no-longer-current file begin to fade.
      const existing = agent.beams.get(norm);
      if (existing && norm !== prevNorm) {
        existing.endAt = Math.min(existing.endAt, now + BEAM_END_FADE_MS);
      }
      return;
    }

    // phase === 'start': this file becomes the agent's current file. Demote the
    // previously-current file's beam to a normal fading one.
    if (prevNorm && prevNorm !== norm) {
      const prevBeam = agent.beams.get(prevNorm);
      if (prevBeam) prevBeam.endAt = now + BEAM_TTL_MS;
    }
    agent.currentFile = file;

    const existing = agent.beams.get(norm);
    if (existing) {
      existing.endAt = Infinity;
      return;
    }
    const beam = createBeam(agent.color, norm, now);
    agent.beams.set(norm, beam);
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
      // Gather live (non-expired) beam targets (X/Z only — Y is the hover line).
      let sx = 0;
      let sz = 0;
      let n = 0;
      for (const [norm, beam] of agent.beams) {
        if (now >= beam.endAt) {
          disposeBeam(this.group, beam);
          agent.beams.delete(norm);
          moving = true; // a beam vanished this frame — paint its removal
          continue;
        }
        // A finite endAt means the beam is on its fade-out clock; keep painting
        // until it expires. A persistent (Infinity) beam at rest needs nothing.
        if (beam.endAt !== Infinity) moving = true;
        // Resolve the file node ONCE here and stash it on the beam so the
        // geometry pass below reuses it instead of a second pathIndex lookup
        // (Part D).
        const node = this.pathIndex.get(norm);
        beam.targetNode = node;
        if (node) {
          sx += node.x ?? 0;
          sz += node.z ?? 0;
          n++;
        }
      }

      // Track horizontally toward the files in play; keep X/Z when idle. Rest is
      // judged by distance to the target (not by easing step), so the node
      // settles right over its files instead of stalling a few units short.
      const tx = n > 0 ? sx / n : agent.pos.x;
      const tz = n > 0 ? sz / n : agent.pos.z;
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

      // Update beam geometries + opacity. Reuse the node resolved in the
      // centroid pass above (Part D) rather than a second pathIndex lookup.
      for (const beam of agent.beams.values()) {
        const node = beam.targetNode;
        const a = agent.pos;
        if (node) {
          this.tmpB.set(node.x ?? a.x, node.y ?? a.y, node.z ?? a.z);
        } else {
          this.tmpB.copy(a);
        }
        updateBeam(beam, a, this.tmpB, now);
      }
    }

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
