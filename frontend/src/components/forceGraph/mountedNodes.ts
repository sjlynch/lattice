// Shared helpers for walking the graph's mounted sim nodes from the overlay
// delta walkers (selection halos, worktree rings, Alt labels). These each used
// to re-derive the same two casts — the `graph.graphData()` node-array fetch and
// the `__threeObj` mounted-root lookup — plus their own `baseSizeFor`. Centralized
// here so a future overlay reuses them instead of re-adding bespoke walkers.
//
// Cache-free by design: every call walks `graphData()` fresh, so a structural
// graphData swap can never serve a stale node or root.

import type { ForceGraph3DInstance } from '3d-force-graph';
import type * as THREE from 'three';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import { isGhost } from './timelineDiff';

// three-forcegraph's default `objBindAttr`: after each `nodeThreeObject` call the
// library stashes the mounted root Object3D back onto the sim node under this
// key. The 3d-force-graph types don't surface it (it's a configurable internal),
// so it's read through a local cast — kept in this one place.
const OBJ_BIND_ATTR = '__threeObj' as const;

export type MountedNode = GraphNode & { [OBJ_BIND_ATTR]?: THREE.Object3D };

// The library's live sim-node array (the same objects it binds `__threeObj`
// onto). `graphData()` isn't typed to return node shapes, so cast locally.
export function mountedNodes(graph: ForceGraph3DInstance): MountedNode[] {
  const getGraphData = graph.graphData as unknown as () => { nodes?: object[] };
  return (getGraphData.call(graph)?.nodes ?? []) as MountedNode[];
}

// The mounted root Object3D for a sim node, if the library has mounted it yet.
export function mountedRoot(node: MountedNode): THREE.Object3D | undefined {
  return node[OBJ_BIND_ATTR];
}

// id → sim-node index for the delta walkers that need O(1) lookups (selection
// add/remove). Rebuilt per call — see the cache-free note above.
export function mountedNodesById(
  graph: ForceGraph3DInstance,
): Map<string, MountedNode> {
  const byId = new Map<string, MountedNode>();
  for (const node of mountedNodes(graph)) {
    if (typeof node.id === 'string') byId.set(node.id, node);
  }
  return byId;
}

// Base ring/halo size for a node, matching the scale `buildNodeObject` used when
// it mounted the sprite: ghost nodes always size off `fileNodeSize`; otherwise
// directories and files take their respective node sizes.
export function baseSizeFor(node: GraphNode, settings: GraphSettings): number {
  if (isGhost(node)) return settings.fileNodeSize;
  return node.kind === 'dir' ? settings.dirNodeSize : settings.fileNodeSize;
}
