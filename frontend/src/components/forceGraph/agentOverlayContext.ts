// Shared mutable state for the Agent Presence Layer, threaded to the focused
// sibling modules (reconcile / activity / satellites / tick) so each owns one
// responsibility while operating on a single overlay's state. `AgentOverlay`
// (agentOverlay.ts) holds one of these and delegates every method to those
// modules — the class is a thin façade so the public API stays stable while the
// logic lives in cohesive units.
//
// The mutable scalars (`nodeSize` / `labelSize` / `spawnCount` /
// `sinceBoundsRecheck`) are reassigned through the ctx object, so a helper that
// bumps `ctx.spawnCount++` or resets `ctx.sinceBoundsRecheck` mutates the one
// shared record. The reusable scratch (`tmpB` / `acc`) is hoisted here off the
// per-frame object literals it replaced — `tick` is not re-entrant, so a single
// shared instance is safe.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { AGENT_GROUP_RENDER_ORDER } from './agentOverlayConstants';
import { AgentPathIndex } from './agentOverlayPathIndex';
import { HoverLine } from './agentOverlayPlacement';
import type { Agent } from './agentOverlayTypes';

export interface AgentOverlayCtx {
  // The THREE.Group added straight to graph.scene() that holds every agent
  // node, satellite, beam, tether, and label (NOT in graphData — see
  // agentOverlay.ts).
  readonly group: THREE.Group;
  // Live agents, keyed by overlay id (taskId / agentId).
  readonly agents: Map<string, Agent>;
  // path → sim-node index + graph-bounds queries.
  readonly pathIndex: AgentPathIndex;
  // Configured file-node size; the sprite is drawn at NODE_SCALE_MULTIPLIER×.
  nodeSize: number;
  // Base height for the file label, kept in sync with the graph's labelSize
  // (same as the Alt-label overlay) so agent labels read at the same scale as
  // file labels. Default mirrors graphSettings until the first tick sets it.
  labelSize: number;
  // Whether to prefix each satellite's file label with its subagent type (and
  // show the bare type before its first file). Off by default; kept in sync
  // with the graph's `showSubagentLabels` setting each frame via setSizes. The
  // orbs and their current-file labels are always drawn.
  showSubagentLabels: boolean;
  // Monotonic spawn counter — feeds each fresh agent's parked-spiral slot.
  spawnCount: number;
  // Smoothed Y of the hover line (above the graph top). Computed from live node
  // positions, low-pass filtered so the agents' height stays steady.
  readonly hoverLine: HoverLine;
  // Frames since the cached graph bounds were last recomputed (see
  // BOUNDS_RECHECK_FRAMES). Forces a periodic refresh so the hover line can't
  // lag node motion that bypasses the engine-hot flag.
  sinceBoundsRecheck: number;
  // Reusable per-frame Vector3 scratch for beam endpoints.
  readonly tmpB: THREE.Vector3;
  // Reusable per-agent centroid accumulator, reset at the top of each agent
  // iteration in tick.
  readonly acc: { sx: number; sz: number; n: number };
}

// Build the shared state and attach the overlay group to the scene.
export function createAgentOverlayCtx(
  graph: ForceGraph3DInstance,
  nodeSize: number,
): AgentOverlayCtx {
  const group = new THREE.Group();
  group.renderOrder = AGENT_GROUP_RENDER_ORDER;
  const scene = (graph as unknown as { scene: () => THREE.Scene }).scene();
  scene.add(group);
  return {
    group,
    agents: new Map(),
    pathIndex: new AgentPathIndex(),
    nodeSize,
    labelSize: 3.0,
    showSubagentLabels: false,
    spawnCount: 0,
    hoverLine: new HoverLine(),
    sinceBoundsRecheck: 0,
    tmpB: new THREE.Vector3(),
    acc: { sx: 0, sz: 0, n: 0 },
  };
}
