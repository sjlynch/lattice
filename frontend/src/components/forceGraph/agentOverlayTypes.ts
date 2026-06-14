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
};

export type AgentDescriptor = { taskId: string; color: string };
