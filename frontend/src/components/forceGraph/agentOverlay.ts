// Scene-level overlay for in-progress Claude agents.
//
// For each live agent we draw a free-floating "Claude node" (see
// claudeNodeSprite). While the agent reads/modifies files (driven by
// `task-activity` WS events) we draw a focus beam from its node to each
// touched file node. Beams fade out on a TTL so several recently-touched
// files stay lit at once (PreToolUse opens/extends a beam; PostToolUse
// shortens it to a quick fade).
//
// The Claude nodes are added directly to `graph.scene()` rather than fed
// through `graphData()` — so an agent appearing/finishing never reheats the
// d3 simulation, and the agent never distorts the DAG layout. Each frame we
// ease the node toward the centroid of its active files (or a parked orbit
// position when idle) and update beam endpoints from the file nodes' live
// positions. `useAgentOverlay` owns the RAF that calls `tick`.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { makeClaudeNode } from './claudeNodeSprite';

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
// How far above the file centroid the node floats, in graph units.
const LIFT = 12;
const GOLDEN_ANGLE = 137.508 * (Math.PI / 180);

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
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
  parkIndex: number;
};

export type AgentDescriptor = { taskId: string; color: string };

export class AgentOverlay {
  private group = new THREE.Group();
  private agents = new Map<string, Agent>();
  private pathIndex = new Map<string, SimNode>();
  private indexedNodes: object[] | null = null;
  private nodeSize: number;
  private spawnCount = 0;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(graph: ForceGraph3DInstance, nodeSize: number) {
    this.nodeSize = nodeSize;
    this.group.renderOrder = 9;
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.add(this.group);
  }

  setNodeSize(size: number): void {
    if (size === this.nodeSize) return;
    this.nodeSize = size;
    const s = size * 1.7;
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
      parkIndex: this.spawnCount,
    });
  }

  private removeAgent(taskId: string): void {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    for (const beam of agent.beams.values()) this.disposeBeam(beam);
    agent.beams.clear();
    this.group.remove(agent.node);
    this.agents.delete(taskId);
  }

  // A `task-activity` event: open/extend (start) or fade (end) a beam.
  addActivity(
    taskId: string,
    file: string,
    phase: 'start' | 'end',
    now: number,
  ): void {
    const agent = this.agents.get(taskId);
    if (!agent) return;
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

  // Per-frame update: ease nodes, refresh beam endpoints, prune expired.
  tick(now: number, graph: ForceGraph3DInstance): void {
    this.ensureIndex(graph);
    for (const agent of this.agents.values()) {
      // Gather live (non-expired) beam targets.
      let sx = 0;
      let sy = 0;
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
          sy += node.y ?? 0;
          sz += node.z ?? 0;
          n++;
        }
      }

      if (n > 0) {
        this.tmpA.set(sx / n, sy / n + LIFT, sz / n);
        agent.pos.lerp(this.tmpA, EASE);
      }
      agent.node.position.copy(agent.pos);

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

  // True while any agent node or beam is on screen — `useAgentOverlay` uses
  // this to know whether to keep the render loop awake.
  isActive(): boolean {
    return this.agents.size > 0;
  }

  destroy(graph: ForceGraph3DInstance): void {
    for (const taskId of [...this.agents.keys()]) this.removeAgent(taskId);
    const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
    scene.remove(this.group);
  }

  private disposeBeam(beam: Beam): void {
    this.group.remove(beam.line);
    beam.geometry.dispose();
    beam.material.dispose();
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

  // A stable orbit slot around the current graph centroid for a freshly
  // spawned agent that has no activity yet. It eases off this the moment it
  // gets a beam target.
  private parkedPosition(index: number): THREE.Vector3 {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    let maxR = 40;
    for (const node of this.pathIndex.values()) {
      cx += node.x ?? 0;
      cy += node.y ?? 0;
      cz += node.z ?? 0;
      n++;
    }
    if (n > 0) {
      cx /= n;
      cy /= n;
      cz /= n;
      for (const node of this.pathIndex.values()) {
        const dx = (node.x ?? 0) - cx;
        const dz = (node.z ?? 0) - cz;
        maxR = Math.max(maxR, Math.hypot(dx, dz));
      }
    }
    const angle = index * GOLDEN_ANGLE;
    const r = maxR * 1.25 + 30;
    return new THREE.Vector3(
      cx + r * Math.cos(angle),
      cy + LIFT,
      cz + r * Math.sin(angle),
    );
  }
}
