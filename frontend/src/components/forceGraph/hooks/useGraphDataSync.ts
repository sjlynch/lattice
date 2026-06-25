import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GitHistoryResult, ScanResult } from '../../../api';
import { getIdleController } from '../idleController';
import { clearAllLabelRegistries, clearLabelsAndRefresh } from './refresh';
import {
  buildForceGraphData,
  indexNodesById,
  isMetricOnlyUpdate,
  patchSimNodeMetrics,
  prepareGhostMerge,
  shapeFingerprint,
  type SimNode,
} from './graphDataSyncCore';

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

function currentNodesById(graph: ForceGraph3DInstance): Map<string, SimNode> {
  const getGraphData = graph.graphData as unknown as () => { nodes?: object[] };
  return indexNodesById(getGraphData.call(graph)?.nodes ?? []);
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
// The pure shape decisions (link cloning, sim-state copy, ghost merge, shape
// fingerprinting, metric-patch detection) live in `graphDataSyncCore`; this
// hook owns the refs, the effect, the registry clears, the ForceGraph reads,
// and the idle-controller calls.
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
    if (
      isMetricOnlyUpdate(
        prevDataRef.current,
        data,
        prevHistoryRef.current,
        history,
        lastShapeRef.current !== null,
      )
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

    const { ghostIds, mergedNodes, mergedLinks } = prepareGhostMerge(data, history);
    ghostsRef.current = ghostIds;
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
    // `cleanupStaleRegistryEntries` pass. The release-aware clear drops each
    // detached sprite's label-texture refcount AND disposes its cloned connector
    // geometry so the caches reclaim them (a bare clear leaks those GPU buffers).
    clearAllLabelRegistries();
    graph.graphData(
      buildForceGraphData(currentNodesById(graph), mergedNodes, mergedLinks, data.root),
    );
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
