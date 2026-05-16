import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GitHistoryResult, GraphLink, GraphNode, ScanResult } from '../../../api';
import { healthLabelRegistry } from '../healthOverlay';
import { labelsRegistry } from '../labelsOverlay';
import { locLabelRegistry } from '../locOverlay';
import { buildGhostGraphData } from '../timelineDiff';

type Args = {
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  data: ScanResult | null;
  history: GitHistoryResult | null;
  onResetSelection: () => void;
};

type SimNode = GraphNode & {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
};

type RuntimeLink = { source: unknown; target: unknown };

const SIM_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'fx', 'fy', 'fz'] as const;

function linkEndpointId(endpoint: unknown): string | null {
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint && typeof endpoint === 'object') {
    const node = endpoint as { id?: unknown; path?: unknown };
    if (typeof node.id === 'string') return node.id;
    if (typeof node.path === 'string') return node.path;
  }
  return null;
}

function cloneLink(link: GraphLink): GraphLink | null {
  const runtimeLink = link as unknown as RuntimeLink;
  const source = linkEndpointId(runtimeLink.source);
  const target = linkEndpointId(runtimeLink.target);
  return source && target ? { source, target } : null;
}

function currentNodesById(graph: ForceGraph3DInstance): Map<string, SimNode> {
  const getGraphData = graph.graphData as unknown as () => { nodes?: object[] };
  const current = getGraphData.call(graph)?.nodes ?? [];
  const out = new Map<string, SimNode>();
  for (const raw of current) {
    const node = raw as Partial<SimNode>;
    if (typeof node.id === 'string') out.set(node.id, raw as SimNode);
  }
  return out;
}

function copySimulationState(target: SimNode, source: SimNode): void {
  for (const key of SIM_KEYS) {
    const value = source[key];
    if (typeof value === 'number') target[key] = value;
  }
}

function hasPosition(node: SimNode): boolean {
  return typeof node.x === 'number'
    && typeof node.y === 'number'
    && typeof node.z === 'number';
}

function seedNewNodePositions(nodes: SimNode[], links: GraphLink[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const link of links) {
    const target = byId.get(link.target);
    if (!target || hasPosition(target)) continue;
    const source = byId.get(link.source);
    if (!source || !hasPosition(source)) continue;
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;
    target.vx = 0;
    target.vy = 0;
    target.vz = 0;
  }
}

function buildForceGraphData(
  graph: ForceGraph3DInstance,
  nodes: GraphNode[],
  links: GraphLink[],
): { nodes: SimNode[]; links: GraphLink[] } {
  const previous = currentNodesById(graph);
  const clonedNodes = nodes.map((node) => {
    const clone = { ...node } as SimNode;
    const prev = previous.get(node.id);
    if (prev) copySimulationState(clone, prev);
    return clone;
  });
  const clonedLinks = links.flatMap((link) => {
    const cloned = cloneLink(link);
    return cloned ? [cloned] : [];
  });
  seedNewNodePositions(clonedNodes, clonedLinks);
  return { nodes: clonedNodes, links: clonedLinks };
}

// Pushes the scan + git history into the ForceGraph instance only when
// either input changes. Ghost nodes (deleted files surfaced from git
// history) are merged into graphData here so the physics simulation
// places them once; scrubbing the timeline only flips visibility/rings
// afterward and never causes a graphData restart. Label registries are
// cleared on every swap because their Sprite references get replaced.
export function useGraphDataSync({
  graphRef,
  data,
  history,
  onResetSelection,
}: Args) {
  const ghostsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    if (!data) {
      graph.graphData({ nodes: [], links: [] });
      ghostsRef.current = new Set();
      return;
    }
    const ghostIds = new Set<string>();
    let ghostNodes: GraphNode[] = [];
    let ghostLinks: GraphLink[] = [];
    if (history && history.isRepo) {
      const built = buildGhostGraphData(data, history.commits, history.uncommitted);
      ghostNodes = built.ghostNodes;
      ghostLinks = built.ghostLinks;
      for (const g of built.ghostNodes) ghostIds.add(g.id);
    }
    ghostsRef.current = ghostIds;
    graph.graphData(buildForceGraphData(
      graph,
      [...data.nodes, ...ghostNodes],
      [...data.links, ...ghostLinks],
    ));
    // A new scan invalidates the previous selection (node IDs may differ).
    onResetSelection();
  }, [data, history]);

  return { ghostsRef };
}
