import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GitHistoryResult, GraphLink, GraphNode, ScanResult } from '../../../api';
import { healthLabelRegistry } from '../healthOverlay';
import { getIdleController } from '../idleController';
import { labelsRegistry } from '../labelsOverlay';
import { locLabelRegistry } from '../locOverlay';
import { buildGhostGraphData } from '../timelineDiff';
import { clearLabelsAndRefresh } from './refresh';

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

// Fields whose values commonly change between scans without altering the
// graph's structural shape — `updated` health events arrive constantly
// while the dev server is writing files. The fast-patch path copies just
// these onto each in-place sim node so a refresh() picks up the new
// values without the library reheating the force engine.
const PATCHABLE_FIELDS = ['health', 'healthDetails', 'loc', 'size'] as const;

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

// A stable, order-insensitive fingerprint of the graph's *shape* — node
// ids + sorted "source|target" link keys joined by newlines. Reused
// across calls so we can detect when an incoming ScanResult reference
// differs only in per-node metric values and skip the (very expensive)
// `graph.graphData(...)` swap, which otherwise reheats the d3 engine for
// the full cooldownTime even when nothing structural moved.
function shapeFingerprint(nodes: GraphNode[], links: GraphLink[]): string {
  const ids = nodes.map((n) => n.id).sort();
  const linkKeys = links.map((l) => `${l.source}|${l.target}`).sort();
  return `${ids.length}:${ids.join(',')}\n${linkKeys.length}:${linkKeys.join(',')}`;
}

// Walks the in-place sim nodes and copies metric fields off the new
// ScanResult. Returns true if any field actually changed (so callers
// can skip the refresh() roundtrip when the swap was a no-op).
function patchSimNodeMetrics(
  graph: ForceGraph3DInstance,
  freshNodes: GraphNode[],
): boolean {
  const current = currentNodesById(graph);
  let changed = false;
  for (const fresh of freshNodes) {
    const sim = current.get(fresh.id);
    if (!sim) continue;
    for (const key of PATCHABLE_FIELDS) {
      const next = fresh[key];
      if (sim[key] !== next) {
        // The accessor signature is uniform across the four patchable
        // fields; the cast keeps TS from widening to `unknown` here.
        (sim as Record<string, unknown>)[key] = next;
        changed = true;
      }
    }
  }
  return changed;
}

// Pushes the scan + git history into the ForceGraph instance only when
// either input changes. Ghost nodes (deleted files surfaced from git
// history) are merged into graphData here so the physics simulation
// places them once; scrubbing the timeline only flips visibility/rings
// afterward and never causes a graphData restart.
//
// **Fast-patch path.** A new ScanResult arrives on every backend
// `HealthUpdate` (file save → vite/tsc emit → AV scan → …). Most of
// those keep the same set of files and links — only one node's
// `health/healthDetails/loc` changes. In that case we mutate those
// fields on the in-place sim nodes and call `graph.refresh()`. We do
// NOT call `graph.graphData(...)` (which would reset the cooldown and
// re-warmup the layout) and we do NOT acquire the idle controller's
// engine reason. This is what keeps the render loop paused on an
// otherwise-idle tab while the dev server churns files in the
// background.
export function useGraphDataSync({
  graphRef,
  data,
  history,
  onResetSelection,
}: Args) {
  const ghostsRef = useRef<Set<string>>(new Set());
  // Fingerprint of the *last graphData() push*. Compared against each
  // incoming ScanResult to choose between the fast-patch and full-swap
  // paths. `null` forces a full swap on first load and after teardown.
  const lastShapeRef = useRef<string | null>(null);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (!data) {
      locLabelRegistry.clear();
      labelsRegistry.clear();
      healthLabelRegistry.clear();
      graph.graphData({ nodes: [], links: [] });
      ghostsRef.current = new Set();
      lastShapeRef.current = null;
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

    const mergedNodes: GraphNode[] = [...data.nodes, ...ghostNodes];
    const mergedLinks: GraphLink[] = [...data.links, ...ghostLinks];
    const nextShape = shapeFingerprint(mergedNodes, mergedLinks);

    if (lastShapeRef.current === nextShape) {
      // Same set of nodes & links — only per-node fields could differ.
      // Patch them in place; the engine stays settled.
      const changed = patchSimNodeMetrics(graph, mergedNodes);
      if (changed) clearLabelsAndRefresh(graph);
      return;
    }

    // Full structural swap. Clear the overlay registries first — the
    // library is about to detach every sprite, so old registry entries
    // would otherwise point at orphaned THREE objects until the next
    // `cleanupStaleRegistryEntries` pass.
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    graph.graphData(buildForceGraphData(graph, mergedNodes, mergedLinks));
    lastShapeRef.current = nextShape;
    // graphData() restarts the d3 force engine — let the idle controller
    // know so it keeps the render loop running until onEngineStop fires.
    getIdleController(graph)?.engineStarted();
    // A new scan invalidates the previous selection (node IDs may differ).
    onResetSelection();
  }, [data, history, graphRef, onResetSelection]);

  return { ghostsRef };
}
