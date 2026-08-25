// Pure graph-shape logic behind `useGraphDataSync`. Everything here is a plain
// data transform or decision — no React, no ForceGraph instance, no registries
// — so it can be unit-tested directly. The hook keeps the refs/effects/registry
// clears/idle-controller calls and the only ForceGraph reads (`graph.graphData()`).
import type { GitHistoryResult, GraphLink, GraphNode, ScanResult } from '../../../api';
import {
  REL_FORWARD_KEY,
  buildGhostGraphData,
  isGhost,
  relForward,
} from '../timelineDiff';

export type SimNode = GraphNode & {
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

export function linkEndpointId(endpoint: unknown): string | null {
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint && typeof endpoint === 'object') {
    const node = endpoint as { id?: unknown; path?: unknown };
    if (typeof node.id === 'string') return node.id;
    if (typeof node.path === 'string') return node.path;
  }
  return null;
}

export function cloneLink(link: GraphLink): GraphLink | null {
  const runtimeLink = link as unknown as RuntimeLink;
  const source = linkEndpointId(runtimeLink.source);
  const target = linkEndpointId(runtimeLink.target);
  return source && target ? { source, target } : null;
}

// Index a raw node array (as returned by `graph.graphData().nodes`) by id. The
// graph read itself stays in the hook; this is the pure mapping half.
export function indexNodesById(nodes: readonly unknown[]): Map<string, SimNode> {
  const out = new Map<string, SimNode>();
  for (const raw of nodes) {
    const node = raw as Partial<SimNode>;
    if (typeof node.id === 'string') out.set(node.id, raw as SimNode);
  }
  return out;
}

export function copySimulationState(target: SimNode, source: SimNode): void {
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

// Clones the merged nodes/links into the shape ForceGraph's `graphData` expects:
// fresh node objects carrying forward the previous frame's simulation state,
// links reduced to `{source, target}` id pairs, and new nodes seeded near a
// placed neighbour. `previous` is the id→sim-node map of the currently-mounted
// nodes (read off the graph by the hook), so this stays a pure transform.
export function buildForceGraphData(
  previous: Map<string, SimNode>,
  nodes: GraphNode[],
  links: GraphLink[],
  root: string,
): { nodes: SimNode[]; links: GraphLink[] } {
  const clonedNodes = nodes.map((node) => {
    const clone = { ...node } as SimNode;
    const prev = previous.get(node.id);
    if (prev) copySimulationState(clone, prev);
    // Precompute the forward-relative path once per scan and stash it on the
    // clone so buildNodeObject can skip recomputing it on every refresh (see
    // readRelForward). Ghosts already carry a relative path and never reach the
    // changeMap lookup, so skip them.
    if (node.kind === 'file' && !isGhost(node)) {
      (clone as Record<string, unknown>)[REL_FORWARD_KEY] =
        relForward(node.path, root);
    }
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
export function shapeFingerprint(nodes: GraphNode[], links: GraphLink[]): string {
  const ids = nodes.map((n) => n.id).sort();
  const linkKeys = links.map((l) => `${l.source}|${l.target}`).sort();
  return `${ids.length}:${ids.join(',')}\n${linkKeys.length}:${linkKeys.join(',')}`;
}

// Walks the in-place sim nodes and copies metric fields off the new
// ScanResult. Returns true if any field actually changed (so callers
// can skip the refresh() roundtrip when the swap was a no-op).
//
// `index` is the id→sim-node Map cached on `nodeIndexRef` — reused across the
// consecutive HealthUpdates that fire constantly while the dev server writes
// files, instead of rebuilt per event. It's invalidated on every full
// `graph.graphData(...)` swap (the only thing that replaces the node array), so
// it can never point at a stale array.
export function patchSimNodeMetrics(
  index: Map<string, SimNode>,
  freshNodes: GraphNode[],
): boolean {
  let changed = false;
  for (const fresh of freshNodes) {
    const sim = index.get(fresh.id);
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

// Decides whether an incoming scan is a cheap metric-only update of the last
// push — same scan root, same `links` array identity (the patch helpers keep
// `prev.links` by reference; any structural change mints a new array), same
// node count, and unchanged `history` ref. When true the merged shape (incl.
// ghost nodes derived from that history) is guaranteed identical to the last
// push, so callers can patch metric fields straight onto the in-place sim
// nodes with NO ghost rebuild and NO sorted shapeFingerprint. `hasPushedShape`
// guards the very first load / post-teardown, where there's nothing to patch.
export function isMetricOnlyUpdate(
  prev: ScanResult | null,
  next: ScanResult,
  prevHistory: GitHistoryResult | null,
  history: GitHistoryResult | null,
  hasPushedShape: boolean,
): boolean {
  return Boolean(
    prev &&
      hasPushedShape &&
      history === prevHistory &&
      next.root === prev.root &&
      next.links === prev.links &&
      next.nodes.length === prev.nodes.length,
  );
}

// Builds the ghost nodes/links for paths in git history that aren't in the
// current scan and merges them with the scan's nodes/links. Pure: the hook just
// stashes the returned `ghostIds` on its ref. Returns empty ghost sets when
// there's no repo history.
export function prepareGhostMerge(
  data: ScanResult,
  history: GitHistoryResult | null,
): { ghostIds: Set<string>; mergedNodes: GraphNode[]; mergedLinks: GraphLink[] } {
  const ghostIds = new Set<string>();
  let ghostNodes: GraphNode[] = [];
  let ghostLinks: GraphLink[] = [];
  if (history && history.isRepo) {
    // `?? []` covers the dev-only window where a hot-reloaded frontend talks to
    // a backend that hasn't restarted yet and so omits the field.
    const built = buildGhostGraphData(data, history.deletedPaths ?? []);
    ghostNodes = built.ghostNodes;
    ghostLinks = built.ghostLinks;
    for (const g of built.ghostNodes) ghostIds.add(g.id);
  }
  const mergedNodes: GraphNode[] = [...data.nodes, ...ghostNodes];
  const mergedLinks: GraphLink[] = [...data.links, ...ghostLinks];
  return { ghostIds, mergedNodes, mergedLinks };
}
