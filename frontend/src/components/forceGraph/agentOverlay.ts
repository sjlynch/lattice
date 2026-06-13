// Scene-level overlay for active Claude agents (both in-worktree task agents
// and non-worktree sessions).
//
// Each live agent draws a free-floating "Claude node" (see claudeNodeSprite)
// that hovers ABOVE the file graph at a stable height: its X/Z ease toward
// the centroid of the files it's currently touching (so it sits over the
// region it's working in) while its Y is pinned just above the top of the
// graph and low-pass filtered so it doesn't bob. A camera-scaled label next
// to the node shows the file it's reading/editing. Focus beams drop from the
// node down to each touched file node and fade out on a TTL, so several
// recently-touched files stay lit at once.
//
// The nodes live directly in `graph.scene()` rather than `graphData()` — so
// an agent appearing/finishing never reheats the d3 simulation or distorts
// the DAG. `useAgentOverlay` owns the RAF that calls `tick`.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { makeClaudeNode } from './claudeNodeSprite';
import { makeFloatingLabelSprite } from './floatingLabelSprite';
import {
  buildMeasuredLabelTexture,
  createLabelTextureCache,
  type LabelTextureOptions,
} from './labelTexture';

// How long a touched file stays beamed after the last activity event.
const BEAM_TTL_MS = 2600;
// After a PostToolUse (tool finished), collapse the remaining TTL to this so
// the beam fades promptly but not instantly.
const BEAM_END_FADE_MS = 700;
// Final fade ramp duration (opacity → 0 over the last stretch of the TTL).
const FADE_MS = 700;
const BEAM_MAX_OPACITY = 0.85;
// Per-frame easing of the node toward its target (0..1; higher = snappier).
const EASE = 0.12;
// Even slower easing for the height, so the hover line stays steady.
const HOVER_EASE = 0.06;
// The above-graph hover line sits this fraction of the graph's vertical
// extent above its top, clamped so it's neither glued to the graph nor lost
// in space on a very tall/short tree.
const HOVER_MARGIN_FRACTION = 0.1;
const HOVER_MARGIN_MIN = 25;
const HOVER_MARGIN_MAX = 220;
const GOLDEN_ANGLE = 137.508 * (Math.PI / 180);

// File label next to the node (camera-scaled, like the Alt-labels overlay).
const LABEL_OPTIONS: LabelTextureOptions = {
  font: '600 44px -apple-system, "Segoe UI", Inter, Roboto, sans-serif',
  strokeWidth: 9,
  height: 72,
  padX: 18,
  minWidth: 72,
  maxEntries: 256,
};
const agentLabelCache = createLabelTextureCache();

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

type SimNode = {
  id?: string;
  path?: string;
  x?: number;
  y?: number;
  z?: number;
};

type Beam = {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  geometry: THREE.BufferGeometry;
  normPath: string;
  openedAt: number;
  endAt: number;
};

type Agent = {
  taskId: string;
  color: string;
  node: THREE.Sprite;
  pos: THREE.Vector3;
  beams: Map<string, Beam>;
  // The file the agent most recently touched — drives the label.
  currentFile?: string;
  label?: THREE.Sprite;
  labelText?: string;
};

export type AgentDescriptor = { taskId: string; color: string };

export class AgentOverlay {
  private group = new THREE.Group();
  private agents = new Map<string, Agent>();
  private pathIndex = new Map<string, SimNode>();
  private indexedNodes: object[] | null = null;
  private nodeSize: number;
  // Base height for the file label, kept in sync with the graph's labelSize
  // (same as the Alt-label overlay) so agent labels read at the same scale as
  // file labels. Default mirrors graphSettings until the first tick sets it.
  private labelSize = 3.0;
  private spawnCount = 0;
  // Smoothed Y of the hover line (above the graph top). Computed from live
  // node positions, low-pass filtered so the agents' height stays steady.
  private hoverY = 0;
  private hoverYInit = false;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(graph: ForceGraph3DInstance, nodeSize: number) {
    this.nodeSize = nodeSize;
    this.group.renderOrder = 9;
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.add(this.group);
  }

  setSizes(nodeSize: number, labelSize: number): void {
    this.labelSize = labelSize;
    if (nodeSize === this.nodeSize) return;
    this.nodeSize = nodeSize;
    const s = nodeSize * 1.7;
    for (const a of this.agents.values()) a.node.scale.set(s, s, 1);
  }

  // Reconcile the live agent set against the latest descriptors.
  setAgents(descriptors: AgentDescriptor[], graph: ForceGraph3DInstance): void {
    const wanted = new Map(descriptors.map((d) => [d.taskId, d]));
    for (const taskId of [...this.agents.keys()]) {
      if (!wanted.has(taskId)) this.removeAgent(taskId);
    }
    for (const d of descriptors) {
      const existing = this.agents.get(d.taskId);
      if (!existing) {
        this.addAgent(d, graph);
      } else if (existing.color !== d.color) {
        // Color slot changed (rare) — rebuild the node sprite.
        this.group.remove(existing.node);
        existing.color = d.color;
        existing.node = makeClaudeNode(d.color, this.nodeSize * 1.7);
        existing.node.position.copy(existing.pos);
        this.group.add(existing.node);
      }
    }
  }

  private addAgent(d: AgentDescriptor, graph: ForceGraph3DInstance): void {
    this.ensureIndex(graph);
    const pos = this.parkedPosition(this.spawnCount++);
    const node = makeClaudeNode(d.color, this.nodeSize * 1.7);
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
    for (const beam of agent.beams.values()) this.disposeBeam(beam);
    agent.beams.clear();
    this.group.remove(agent.node);
    if (agent.label) this.group.remove(agent.label);
    this.agents.delete(taskId);
  }

  // A `task-activity` / `agent-activity` event: open/extend (start) or fade
  // (end) a beam, and record the touched file for the label.
  addActivity(
    taskId: string,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): void {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    agent.currentFile = file;
    const norm = normalizePath(file);
    const existing = agent.beams.get(norm);
    if (phase === 'end') {
      if (existing) {
        existing.endAt = Math.min(existing.endAt, now + BEAM_END_FADE_MS);
      }
      return;
    }
    if (existing) {
      existing.endAt = now + BEAM_TTL_MS;
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(agent.color),
      transparent: true,
      opacity: BEAM_MAX_OPACITY,
      depthWrite: false,
      depthTest: false,
    });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 9;
    line.raycast = () => {};
    agent.beams.set(norm, {
      line,
      material,
      geometry,
      normPath: norm,
      openedAt: now,
      endAt: now + BEAM_TTL_MS,
    });
    this.group.add(line);
  }

  // Per-frame update: refresh the hover line, ease nodes, update labels +
  // beams, prune expired beams.
  tick(now: number, graph: ForceGraph3DInstance): void {
    this.ensureIndex(graph);
    this.updateHoverY();

    for (const agent of this.agents.values()) {
      // Gather live (non-expired) beam targets (X/Z only — Y is the hover line).
      let sx = 0;
      let sz = 0;
      let n = 0;
      for (const [norm, beam] of agent.beams) {
        if (now >= beam.endAt) {
          this.disposeBeam(beam);
          agent.beams.delete(norm);
          continue;
        }
        const node = this.pathIndex.get(norm);
        if (node) {
          sx += node.x ?? 0;
          sz += node.z ?? 0;
          n++;
        }
      }

      // Track horizontally toward the files in play; keep X/Z when idle.
      const tx = n > 0 ? sx / n : agent.pos.x;
      const tz = n > 0 ? sz / n : agent.pos.z;
      this.tmpA.set(tx, this.hoverY, tz);
      agent.pos.x += (this.tmpA.x - agent.pos.x) * EASE;
      agent.pos.z += (this.tmpA.z - agent.pos.z) * EASE;
      agent.pos.y += (this.tmpA.y - agent.pos.y) * HOVER_EASE;
      agent.node.position.copy(agent.pos);

      // Only label while the agent is actively touching files (has a live
      // beam). When it stops reading/editing the beams drain and the label
      // disappears with them — no stale last-file label left hanging.
      if (agent.beams.size > 0 && agent.currentFile) this.updateLabel(agent);
      else this.clearLabel(agent);

      // Update beam geometries + opacity.
      for (const beam of agent.beams.values()) {
        const node = this.pathIndex.get(beam.normPath);
        const attr = beam.geometry.getAttribute('position') as THREE.BufferAttribute;
        const a = agent.pos;
        attr.setXYZ(0, a.x, a.y, a.z);
        if (node) {
          this.tmpB.set(node.x ?? a.x, node.y ?? a.y, node.z ?? a.z);
        } else {
          this.tmpB.copy(a);
        }
        attr.setXYZ(1, this.tmpB.x, this.tmpB.y, this.tmpB.z);
        attr.needsUpdate = true;
        const remaining = beam.endAt - now;
        const fade = remaining < FADE_MS ? Math.max(0, remaining / FADE_MS) : 1;
        beam.material.opacity = BEAM_MAX_OPACITY * fade;
      }
    }
  }

  // True while any agent node is on screen — `useAgentOverlay` uses this to
  // know whether to keep the render loop awake.
  isActive(): boolean {
    return this.agents.size > 0;
  }

  destroy(graph: ForceGraph3DInstance): void {
    for (const taskId of [...this.agents.keys()]) this.removeAgent(taskId);
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.remove(this.group);
  }

  // Build/refresh the label sprite next to a node, showing its current file.
  private updateLabel(agent: Agent): void {
    if (!agent.currentFile) return;
    const text = baseName(agent.currentFile);
    if (!agent.label || agent.labelText !== text) {
      if (agent.label) this.group.remove(agent.label);
      const tex = buildMeasuredLabelTexture(
        agentLabelCache,
        text,
        agent.color,
        LABEL_OPTIONS,
      );
      // Same base height + config as the Alt-label overlay so agent labels
      // read at the same (small) scale as the file labels.
      const label = makeFloatingLabelSprite(tex, this.labelSize, {
        heightMultiplier: 1.6,
        maxScale: 120,
        aspectFallback: 3,
      });
      label.renderOrder = 14; // above the node body (13)
      label.raycast = () => {}; // decorative — never a hover/pick target
      agent.label = label;
      agent.labelText = text;
      this.group.add(label);
    }
    // Sit just to the right of and slightly above the node.
    agent.label.position.set(
      agent.pos.x + this.nodeSize * 1.6,
      agent.pos.y + this.nodeSize * 0.9,
      agent.pos.z,
    );
  }

  // Drop the label when the agent isn't actively touching files.
  private clearLabel(agent: Agent): void {
    if (agent.label) {
      this.group.remove(agent.label);
      agent.label = undefined;
    }
    agent.labelText = undefined;
    agent.currentFile = undefined;
  }

  private disposeBeam(beam: Beam): void {
    this.group.remove(beam.line);
    beam.geometry.dispose();
    beam.material.dispose();
  }

  // Low-pass the hover line toward (graph top + margin) so the agents float a
  // steady distance above the file graph even as the layout settles.
  private updateHoverY(): void {
    const bounds = this.graphBounds();
    if (!bounds) return;
    const margin = Math.min(
      HOVER_MARGIN_MAX,
      Math.max(HOVER_MARGIN_MIN, (bounds.maxY - bounds.minY) * HOVER_MARGIN_FRACTION),
    );
    const target = bounds.maxY + margin;
    if (!this.hoverYInit) {
      this.hoverY = target;
      this.hoverYInit = true;
    } else {
      this.hoverY += (target - this.hoverY) * HOVER_EASE;
    }
  }

  private graphBounds(): { minY: number; maxY: number } | null {
    let minY = Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const node of this.pathIndex.values()) {
      const y = node.y ?? 0;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
    return count > 0 ? { minY, maxY } : null;
  }

  // Rebuild the path→node index only when the library swaps the nodes array
  // (a structural graphData() change). Positions on the same node objects
  // update in place, so the cached refs stay valid between swaps.
  private ensureIndex(graph: ForceGraph3DInstance): void {
    const getData = graph.graphData as unknown as () => { nodes?: object[] };
    const nodes = getData.call(graph)?.nodes ?? [];
    if (nodes === this.indexedNodes) return;
    this.indexedNodes = nodes;
    this.pathIndex.clear();
    for (const obj of nodes as SimNode[]) {
      if (typeof obj.path === 'string') {
        this.pathIndex.set(normalizePath(obj.path), obj);
      }
    }
  }

  // A stable spot on the hover line (above the graph) for a freshly spawned
  // agent with no activity yet — spread around the graph centroid by index.
  private parkedPosition(index: number): THREE.Vector3 {
    let cx = 0;
    let cz = 0;
    let n = 0;
    let maxR = 40;
    const bounds = this.graphBounds();
    const y = bounds
      ? bounds.maxY +
        Math.min(
          HOVER_MARGIN_MAX,
          Math.max(HOVER_MARGIN_MIN, (bounds.maxY - bounds.minY) * HOVER_MARGIN_FRACTION),
        )
      : 0;
    for (const node of this.pathIndex.values()) {
      cx += node.x ?? 0;
      cz += node.z ?? 0;
      n++;
    }
    if (n > 0) {
      cx /= n;
      cz /= n;
      for (const node of this.pathIndex.values()) {
        const dx = (node.x ?? 0) - cx;
        const dz = (node.z ?? 0) - cz;
        maxR = Math.max(maxR, Math.hypot(dx, dz));
      }
    }
    const angle = index * GOLDEN_ANGLE;
    const r = maxR * 0.6 + 20;
    return new THREE.Vector3(cx + r * Math.cos(angle), y, cz + r * Math.sin(angle));
  }
}
