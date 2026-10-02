import { useEffect, useRef, useState, type MutableRefObject } from 'react';
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

// Trailing window that coalesces the fast-patch path's refreshes while an
// H/Z/D view is held or pinned. The scan scheduler flushes backend `updated`
// events in METRIC_BATCH_MS (50 ms) batches, and one save, a merge that
// fast-forwards main, or a cross-file dependent cascade arrives as a burst of
// them. Each `graph.refresh()` frees and rebuilds EVERY node and link THREE
// object (≈25–30 MB of short-lived JS on a 3k-file project, promoted to
// old-space because it lives until the next refresh), so a refresh per batch
// meant up to ~20 full scene rebuilds a second for as long as a pin stayed on.
// The metric fields are still patched onto the sim nodes immediately; only the
// repaint waits. The overlay toggle (keydown / pin) still refreshes at once.
export const METRIC_REFRESH_COALESCE_MS = 400;

type TimerRef = MutableRefObject<ReturnType<typeof setTimeout> | null>;

function cancelMetricRefresh(timerRef: TimerRef): void {
  if (timerRef.current === null) return;
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

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
// fields on the in-place sim nodes and, only while an H/Z/D view shows them,
// schedule ONE coalesced `graph.refresh()` (METRIC_REFRESH_COALESCE_MS). We do
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
  // Bumped on every *full graphData() swap* (the only path that replaces the
  // node/link object arrays). The batched renderers (instancedLinks /
  // instancedNodes) capture those arrays at their last rebuild and read them in
  // syncPositions, so they MUST re-capture after a swap. A swap can happen on a
  // signal the batched rebuild effects don't otherwise see: those key off
  // `useStructuralScan` (memoized purely on `data.links` identity), but the
  // ghost set folded into the swap derives from `history`, not `data` — so when
  // git history resolves (~1s after open) and adds deleted-file ghosts, the
  // shape changes and we swap while `data`/`data.links` are unchanged. Threading
  // this counter into the rebuild effects' deps drives a re-capture on every
  // swap, including those history-only ones.
  const [dataGeneration, setDataGeneration] = useState(0);
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
  // The single pending coalesced metric refresh (see METRIC_REFRESH_COALESCE_MS).
  // Cancelled on unmount, on the `!data` reset and on a full swap; NOT on the
  // main effect's per-update cleanup, which would turn every batch of a long
  // burst into a reschedule and hold the repaint off until the burst ends.
  const pendingMetricRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => cancelMetricRefresh(pendingMetricRefreshRef), []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const metricOverlayActive = () =>
      healthModeRef.current || locModeRef.current || deadModeRef.current;
    // Repaint the patched metric fields once per window. A batch arriving while
    // a refresh is already pending joins it: that refresh reads the sim nodes
    // when it fires, so it paints this batch's values too.
    const scheduleMetricRefresh = () => {
      if (pendingMetricRefreshRef.current !== null) return;
      pendingMetricRefreshRef.current = setTimeout(() => {
        pendingMetricRefreshRef.current = null;
        // The view may have been released (its keyup already refreshed) or the
        // graph remounted while the refresh waited.
        if (graphRef.current !== graph || !metricOverlayActive()) return;
        clearLabelsAndRefresh(graph);
      }, METRIC_REFRESH_COALESCE_MS);
    };
    if (!data) {
      cancelMetricRefresh(pendingMetricRefreshRef);
      // Batched: release without evicting; the deferred trim runs after the
      // library's digest has removed the nodes (hooks/refresh.ts).
      clearAllLabelRegistries('batched');
      graph.graphData({ nodes: [], links: [] });
      if (lastShapeRef.current !== null) setDataGeneration((g) => g + 1);
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
      if (changed && metricOverlayActive()) scheduleMetricRefresh();
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
      // Coalesced like the cheap path above.
      if (changed && metricOverlayActive()) scheduleMetricRefresh();
      prevDataRef.current = data;
      prevHistoryRef.current = history;
      return;
    }

    // Full structural swap. `graph.graphData(...)` rebuilds every node object,
    // so a pending coalesced refresh would only repeat that work.
    cancelMetricRefresh(pendingMetricRefreshRef);
    // Clear the overlay registries first — the library is about to detach
    // every sprite, so old registry entries would otherwise point at orphaned
    // THREE objects until the next `cleanupStaleRegistryEntries` pass. The
    // release-aware clear balances each detached sprite's label-texture
    // refcount. Batched: the swap's rebuild re-acquires the labels still shown
    // instead of redrawing them, and one deferred trim follows (refresh.ts).
    clearAllLabelRegistries('batched');
    graph.graphData(
      buildForceGraphData(currentNodesById(graph), mergedNodes, mergedLinks, data.root),
    );
    // The node array was replaced — drop the cached id→node index so the next
    // metric patch rebuilds it against the new array rather than the old one.
    nodeIndexRef.current = null;
    lastShapeRef.current = nextShape;
    prevDataRef.current = data;
    prevHistoryRef.current = history;
    // The node/link arrays were just replaced — bump the generation so the
    // batched renderers re-capture them (their rebuild effects depend on this).
    // Functional update: doesn't read `dataGeneration`, so the effect needn't
    // depend on it (no re-swap loop — this effect keys only on data/history).
    setDataGeneration((g) => g + 1);
    // graphData() restarts the d3 force engine — let the idle controller
    // know so it keeps the render loop running until onEngineStop fires.
    getIdleController(graph)?.engineStarted();
    // A new scan invalidates the previous selection (node IDs may differ).
    onResetSelection();
  }, [data, history, graphRef, onResetSelection, healthModeRef, locModeRef, deadModeRef]);

  return { ghostsRef, dataGeneration };
}
