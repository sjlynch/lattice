import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GitHistoryResult, GraphLink, GraphNode, ScanResult } from '../../../api';
import { getIdleController } from '../idleController';
import {
  REL_FORWARD_KEY,
  buildGhostGraphData,
  isGhost,
  relForward,
} from '../timelineDiff';
import { clearAllLabelRegistries, clearLabelsAndRefresh } from './refresh';

type Args = {
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  data: ScanResult | null;
  history: GitHistoryResult | null;
  onResetSelection: () => void;
  // The three overlays that actually render the patched metric fields. When
  // none is held the rebuilt sprites would be byte-identical, so the
  // fast-patch path skips its `graph.refresh()` entirely (see below).
  healthModeRef: MutableRefObject<boolean>;
  locModeRef: MutableRefObject<boolean>;
  deadModeRef: MutableRefObject<boolean>;
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
  root: string,
): { nodes: SimNode[]; links: GraphLink[] } {
  const previous = currentNodesById(graph);
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
function shapeFingerprint(nodes: GraphNode[], links: GraphLink[]): string {
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
function patchSimNodeMetrics(
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

// Lazily (re)builds the cached id→sim-node index. Rebuilt only when the ref was
// invalidated by a full graphData swap; otherwise reused across HealthUpdates.
function ensureNodeIndex(
  graph: ForceGraph3DInstance,
  indexRef: MutableRefObject<Map<string, SimNode> | null>,
): Map<string, SimNode> {
  if (!indexRef.current) indexRef.current = currentNodesById(graph);
  return indexRef.current;
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
  healthModeRef,
  locModeRef,
  deadModeRef,
}: Args) {
  const ghostsRef = useRef<Set<string>>(new Set());
  // Fingerprint of the *last graphData() push*. Compared against each
  // incoming ScanResult to choose between the fast-patch and full-swap
  // paths. `null` forces a full swap on first load and after teardown.
  const lastShapeRef = useRef<string | null>(null);
  // id→sim-node index for the *current* graphData node array. Cached across
  // the constant stream of metric HealthUpdates and rebuilt lazily; nulled on
  // every full graphData swap so it can never reference a replaced array.
  const nodeIndexRef = useRef<Map<string, SimNode> | null>(null);
  // The last `data` / `history` refs we processed — used by the cheap
  // metric-only fast path to detect a `patchUpdatedFiles` burst without
  // building ghosts or the sorted shape fingerprint.
  const prevDataRef = useRef<ScanResult | null>(null);
  const prevHistoryRef = useRef<GitHistoryResult | null>(null);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (!data) {
      clearAllLabelRegistries();
      graph.graphData({ nodes: [], links: [] });
      nodeIndexRef.current = null;
      ghostsRef.current = new Set();
      lastShapeRef.current = null;
      prevDataRef.current = null;
      prevHistoryRef.current = null;
      return;
    }

    // ----- Cheap metric-only fast path -----
    // A `patchUpdatedFiles` burst keeps the scan root, the `links` array
    // identity, and the node count stable, and arrives while `history` is
    // unchanged — which guarantees the merged shape (incl. ghost nodes derived
    // from that history) is identical to the last push. So we can patch the
    // metric fields straight onto the in-place sim nodes with NO ghost rebuild
    // and NO sorted shapeFingerprint. The fingerprint fallback below still
    // covers full scans, ghost-history changes, removals, and same-shape
    // rescans from fresh backend responses (all of which mint a new links
    // array or change `history`).
    const prevData = prevDataRef.current;
    if (
      prevData &&
      lastShapeRef.current !== null &&
      history === prevHistoryRef.current &&
      data.root === prevData.root &&
      data.links === prevData.links &&
      data.nodes.length === prevData.nodes.length
    ) {
      const changed = patchSimNodeMetrics(
        ensureNodeIndex(graph, nodeIndexRef),
        data.nodes,
      );
      // Only the H/Z/D overlays render the patched fields; with none held a
      // refresh would rebuild every sprite to a byte-identical result and wake
      // the render loop on every HealthUpdate. The fields are patched in place
      // either way, so toggling an overlay on later picks up the latest values.
      const metricOverlayActive =
        healthModeRef.current || locModeRef.current || deadModeRef.current;
      if (changed && metricOverlayActive) clearLabelsAndRefresh(graph);
      prevDataRef.current = data;
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
      // Patch them in place; the engine stays settled. (Reached for same-shape
      // rescans from fresh backend responses, where the cheap path's links
      // identity check fails but the shape is unchanged.)
      const changed = patchSimNodeMetrics(
        ensureNodeIndex(graph, nodeIndexRef),
        mergedNodes,
      );
      // Only the H/Z/D overlays render the patched health/loc/deadCode fields.
      // With none held, a `graph.refresh()` would rebuild all N sprites to a
      // byte-identical result — pure waste that ALSO wakes the render loop on
      // every backend HealthUpdate (which stream constantly while the dev
      // server writes files), pinning the loop at 100% CPU on an otherwise idle
      // tab. So refresh only when an overlay is actually showing those values;
      // the fields are still patched in place, so toggling an overlay on later
      // (its keydown calls clearLabelsAndRefresh) picks up the latest values.
      const metricOverlayActive =
        healthModeRef.current || locModeRef.current || deadModeRef.current;
      if (changed && metricOverlayActive) clearLabelsAndRefresh(graph);
      prevDataRef.current = data;
      prevHistoryRef.current = history;
      return;
    }

    // Full structural swap. Clear the overlay registries first — the
    // library is about to detach every sprite, so old registry entries
    // would otherwise point at orphaned THREE objects until the next
    // `cleanupStaleRegistryEntries` pass. The release-aware clear also drops
    // each detached sprite's label-texture reference so the caches reclaim them.
    clearAllLabelRegistries();
    graph.graphData(buildForceGraphData(graph, mergedNodes, mergedLinks, data.root));
    // The node array was replaced — drop the cached id→node index so the next
    // metric patch rebuilds it against the new array rather than the old one.
    nodeIndexRef.current = null;
    lastShapeRef.current = nextShape;
    prevDataRef.current = data;
    prevHistoryRef.current = history;
    // graphData() restarts the d3 force engine — let the idle controller
    // know so it keeps the render loop running until onEngineStop fires.
    getIdleController(graph)?.engineStarted();
    // A new scan invalidates the previous selection (node IDs may differ).
    onResetSelection();
  }, [data, history, graphRef, onResetSelection, healthModeRef, locModeRef, deadModeRef]);

  return { ghostsRef };
}
