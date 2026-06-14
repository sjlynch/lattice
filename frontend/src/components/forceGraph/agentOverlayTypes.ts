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

// Live state for one on-screen agent: its node sprite, eased position, open
// beams, and the label showing its most-recently-touched file.
export type Agent = {
  taskId: string;
  color: string;
  node: THREE.Sprite;
  pos: THREE.Vector3;
  beams: Map<string, Beam>;
  // The file the agent most recently touched — drives the label.
  currentFile?: string;
  label?: THREE.Sprite;
  labelText?: string;
  // Inputs (node pos + size) of the last label-position write, so an unchanged
  // input skips the redundant position.set (Part D). Undefined until first set.
  labelPosX?: number;
  labelPosY?: number;
  labelPosZ?: number;
  labelNodeSize?: number;
};

export type AgentDescriptor = { taskId: string; color: string };
