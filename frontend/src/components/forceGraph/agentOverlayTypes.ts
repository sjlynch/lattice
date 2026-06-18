// Shared types for the Claude-agent overlay (see agentOverlay.ts).

import type * as THREE from 'three';

// A d3-force sim node as we read it off `graph.graphData().nodes` — only the
// fields the overlay touches.
export type SimNode = {
  id?: string;
  path?: string;
  x?: number;
  y?: number;
  z?: number;
};

// A focus beam (THREE.Line) from an agent node down to a file it touched.
export type Beam = {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  geometry: THREE.BufferGeometry;
  normPath: string;
  openedAt: number;
  endAt: number;
  // Last endpoints uploaded to the geometry (NaN until the first updateBeam), so
  // a beam over stationary nodes skips the per-frame GPU re-upload (Part B).
  lastFromX: number;
  lastFromY: number;
  lastFromZ: number;
  lastToX: number;
  lastToY: number;
  lastToZ: number;
  // Transient: the file node this beam targets, resolved once per frame in the
  // centroid pass and reused in the geometry pass (Part D). Not persisted state.
  targetNode?: SimNode;
};

// The label-bearing fields shared by an Agent and a Satellite, so the label
// build/place/clear helpers (agentOverlayLabels.ts) work on either. The cached
// label-position inputs let an unchanged position skip the redundant
// `position.set` once the host settles (Part D).
export type LabelHost = {
  color: string;
  label?: THREE.Sprite;
  labelText?: string;
  labelPosX?: number;
  labelPosY?: number;
  labelPosZ?: number;
  labelNodeSize?: number;
};

// Live state for one subagent (a Task/Agent) shown as a satellite of its
// parent agent's node. Mirrors an Agent's node/beam/label machinery, plus the
// fixed ring `slot` (assigned at spawn) that gives it a stable direction
// around the parent, and `lastSeen` for the missed-SubagentStop idle reap.
export type Satellite = LabelHost & {
  subagentId: string;
  subagentType?: string;
  slot: number;
  node: THREE.Sprite;
  pos: THREE.Vector3;
  // Persistent line from the parent node to this satellite (constant opacity).
  tether: Beam;
  beams: Map<string, Beam>;
  // The file this subagent most recently touched — drives its beam persistence.
  currentFile?: string;
  // Last activity/spawn time (frontend clock), for the idle-reap safety net.
  lastSeen: number;
};

// Live state for one on-screen agent: its node sprite, eased position, open
// beams, the label showing its most-recently-touched file, and any live
// subagent satellites hanging off it.
export type Agent = LabelHost & {
  taskId: string;
  node: THREE.Sprite;
  pos: THREE.Vector3;
  beams: Map<string, Beam>;
  // The file the agent most recently touched — drives the label.
  currentFile?: string;
  // Subagents currently shown as satellites, keyed by subagentId.
  satellites: Map<string, Satellite>;
};

export type AgentDescriptor = { taskId: string; color: string };
