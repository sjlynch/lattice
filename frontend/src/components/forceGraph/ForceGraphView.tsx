import { useCallback, useMemo, useRef, useState } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../api';
import { GraphViewChrome } from './GraphViewChrome';
import { GraphRendererNotice } from './GraphRendererNotice';
import { describeRendererFailure, type RendererStatus } from './rendererStatus';
import { useGraphViewChromeModel } from './useGraphViewChromeModel';
import { useStructuralScan } from '../../hooks/useStructuralScan';
import { useBoxSelect } from './hooks/useBoxSelect';
import { useAgentOverlay } from './hooks/useAgentOverlay';
import { useBatchedLinks } from './hooks/useBatchedLinks';
import { useInstancedNodes } from './hooks/useInstancedNodes';
import { useNodeDragBehavior } from './hooks/useNodeDragBehavior';
import { useForceGraphInitialization } from './hooks/useForceGraphInitialization';
import { useCameraPersistence } from './hooks/useCameraPersistence';
import { useRadialTidyLayout } from './hooks/useRadialTidyLayout';
import { useGraphDataSync } from './hooks/useGraphDataSync';
import { useGraphOverlays } from './hooks/useGraphOverlays';
import { useGraphSearchController } from './hooks/useGraphSearchController';
import { useGraphTaskCreation } from './hooks/useGraphTaskCreation';
import { useNodeContextMenu } from './hooks/useNodeContextMenu';
import { useWorktreeHighlight } from './hooks/useWorktreeHighlight';
import { useHoverNodeDebounce } from './hooks/useHoverNodeDebounce';
import { useCanvasDragTracking } from './hooks/useCanvasDragTracking';
import { useRefMirror } from './hooks/useRefMirror';
import { useSelectionHaloSync } from './hooks/useSelectionHaloSync';
import { useSelectionHaloPulse } from './hooks/useSelectionHaloPulse';
import { useSelectionGlowSettings } from './hooks/useSelectionGlowSettings';
import { useMetricsIgnoreRefresh } from './hooks/useMetricsIgnoreRefresh';
import { useGraphViewKeyboard } from './hooks/useGraphViewKeyboard';
import { useOverlayTooltipDismiss } from './hooks/useOverlayTooltipDismiss';

type Props = {
  data: ScanResult | null;
  loading: boolean;
  hiddenExts: Set<string>;
  // Extensions (leading dot, lowercase) skipped by the LOC and code-health
  // overlays. Files with a matching extension fall back to their normal
  // sprite — no colored tint, no numeric label.
  metricsIgnoredExts: string[];
  activeFolder: string;
  // Code-health overlay state. Lifted to App so the Legend can swap to
  // a health breakdown panel while `h` is held; the keydown listener
  // still lives in this component and pushes changes back via the
  // callback below.
  healthMode: boolean;
  onHealthModeChange: (mode: boolean) => void;
};

type RendererCallbacks = {
  onRendererFailure: (error: unknown) => void;
  onContextLost: () => void;
  onContextRestored: () => void;
};

// A WebGL fault is the one mount failure the graph is expected to survive (the
// browser can refuse a context outright — see ./rendererStatus), so the
// exported component is a thin retry shell around the coordinator. Retry
// *remounts* it rather than re-running init alone: every hook below wires
// itself to the graph instance at mount, so a graph that appeared later would
// have nothing attached to it.
export function ForceGraphView(props: Props) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<RendererStatus>({ kind: 'ok' });

  const onRendererFailure = useCallback((error: unknown) => {
    console.error('[graph] renderer unavailable:', error);
    setStatus(describeRendererFailure(error));
  }, []);
  const onContextLost = useCallback(() => setStatus({ kind: 'lost' }), []);
  const onContextRestored = useCallback(() => setStatus({ kind: 'ok' }), []);
  const retry = useCallback(() => {
    setStatus({ kind: 'ok' });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <div className="graph-view-root">
      <ForceGraphViewCoordinator
        key={attempt}
        {...props}
        onRendererFailure={onRendererFailure}
        onContextLost={onContextLost}
        onContextRestored={onContextRestored}
      />
      {status.kind !== 'ok' && (
        <GraphRendererNotice status={status} onRetry={retry} />
      )}
    </div>
  );
}

// Hosts the 3d-force-graph instance and stitches together the per-concern
// hooks under ./hooks/: graph initialization, settings persistence, git
// timeline, LOC / health / labels overlays, shift-drag box-select, and the
// right-click "create task" menu. Render-only chrome lives in the
// Graph*.tsx siblings.
function ForceGraphViewCoordinator({
  data,
  loading,
  hiddenExts,
  metricsIgnoredExts,
  activeFolder,
  healthMode,
  onHealthModeChange,
  onRendererFailure,
  onContextLost,
  onContextRestored,
}: Props & RendererCallbacks) {
  // ----- Phase 1: shared refs and overlay state -----
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Hover tooltip state + its null-transition debounce (see the hook). Hover is
  // gated off while a pointer is dragging the canvas: the shared
  // `pointerDraggingRef` is read by the debounce and driven by the drag tracker,
  // which also calls `cancelPendingHoverClear` at drag start to hide the tooltip.
  const pointerDraggingRef = useRef(false);
  const { hoverNode, debouncedSetHoverNode, cancelPendingHoverClear } =
    useHoverNodeDebounce(pointerDraggingRef);
  useCanvasDragTracking(
    containerRef,
    graphRef,
    pointerDraggingRef,
    cancelPendingHoverClear,
  );

  const selectedRef = useRefMirror(selected);
  const hiddenExtsRef = useRefMirror(hiddenExts);
  const dataRef = useRefMirror(data);
  // Structure-only view of the scan: a reference that's stable across the
  // metric-only HealthUpdates that churn `data` on every file save, changing
  // only when files are added/removed/renamed. The file/dir counts read only
  // structural fields (kind/ext), so keying their memo off this skips the O(N)
  // recount + HUD re-render on every save.
  const structuralData = useStructuralScan(data);

  // Build a Set once per change so the lookup is O(1) per node. Lowercased
  // for case-insensitive matching against `node.ext`.
  const metricsIgnoredExtsSet = useMemo(
    () => new Set(metricsIgnoredExts.map((e) => e.toLowerCase())),
    [metricsIgnoredExts],
  );
  const metricsIgnoredExtsRef = useRefMirror(metricsIgnoredExtsSet);

  // ----- Phase 2: graph initialization + overlays -----
  const {
    settings,
    setSettings,
    settingsRef,
    history,
    range,
    setRange,
    changeMapRef,
    locMode,
    locModeRef,
    healthModeRef,
    deadMode,
    deadModeRef,
    labelMode,
    labelModeRef,
    labelShift,
    labelShiftRef,
    labelLevel,
    labelLevelRef,
    maxDepthRef,
    maxDirDepthRef,
    nodeDepthsRef,
    pinned,
    togglePin,
  } = useGraphOverlays({
    activeFolder,
    graphRef,
    containerRef,
    data,
    hiddenExts,
    metricsIgnoredExtsRef,
    healthMode,
    onHealthModeChange,
    selected,
  });

  // Mirror of the batched-nodes toggle, read live by nodeObjectFactory to hide
  // the per-node base sprite (kept as the raycast pick proxy) — seeded from the
  // persisted setting on first render so init builds sprites at the right
  // visibility, then kept in sync for runtime toggles.
  const batchedNodesRef = useRefMirror(settings.batchedNodes);

  // The `W` worktree overlay's live path→color snapshot (null while inactive).
  // Written by useWorktreeHighlight, read by nodeObjectFactory so any full
  // sprite rebuild while the view is active re-attaches the rings instead of
  // dropping them (see worktreeRingSync).
  const worktreeRingsRef = useRef<Map<string, string> | null>(null);

  useForceGraphInitialization(containerRef, graphRef, {
    settingsRef,
    selectedRef,
    dataRef,
    locModeRef,
    healthModeRef,
    deadModeRef,
    labelModeRef,
    labelShiftRef,
    labelLevelRef,
    nodeDepthsRef,
    changeMapRef,
    metricsIgnoredExtsRef,
    batchedNodesRef,
    worktreeRingsRef,
    onHoverNodeChange: debouncedSetHoverNode,
    onRendererFailure,
    onContextLost,
    onContextRestored,
  });

  // Save the camera position/orbit target per project and restore it on mount /
  // project switch, so a page refresh keeps the user's vantage point.
  useCameraPersistence(graphRef, activeFolder);

  // True while a recolor view (health/loc/dead) is showing. These views pare the
  // graph down to the metric signal — hiding ghost nodes + metrics-ignored files
  // and suppressing change-rings — so the batched-link buffer must re-capture
  // its visible set when this flips (see useBatchedLinks).
  const metricOverlayActive = healthMode || locMode || deadMode;

  const resetSelection = useCallback(() => setSelected(new Set()), []);

  // `dataGeneration` bumps on every full graphData() swap (incl. the git-history
  // ghost merge, which doesn't touch `structuralData`). Threaded into the
  // batched renderers below so they re-capture the fresh node/link arrays after
  // a swap instead of rendering the orphaned pre-swap objects.
  const { dataGeneration } = useGraphDataSync({
    graphRef,
    data,
    history,
    onResetSelection: resetSelection,
    healthModeRef,
    locModeRef,
    deadModeRef,
  });

  // Radial tidy-tree untangle: on first load (and via the Spread tab's "Untangle
  // now" button) seed each subtree into its own angular wedge so sibling
  // subtrees don't tangle, then let the physics settle from that seed. On by
  // default. Placed after the data sync so the nodes are in the sim.
  const runLayout = useRadialTidyLayout(
    graphRef,
    structuralData,
    settingsRef,
    activeFolder,
  );

  // Batched link rendering: collapse the library's per-link Line objects into a
  // single LineSegments so orbiting a settled graph isn't E extra draw calls per
  // frame. Keyed off graphData swaps, so identical structural rescans neither
  // rebuild GPU buffers nor wake an otherwise settled scene.
  useBatchedLinks(
    graphRef,
    settings.batchedLinks,
    hiddenExts,
    dataGeneration,
    metricOverlayActive,
  );

  // Batched node rendering: draw the base node shapes as a few instanced meshes
  // (one per file type) instead of N Sprite-bearing Groups, so orbiting a
  // settled graph isn't ~N node draw calls per frame. The per-node sprite stays
  // mounted-but-invisible as the pick proxy (see nodeObjectFactory); recolor
  // overlays (health/loc/dead) fall back to the per-node path. Like links, the
  // buffers rebuild only when graphData or the visible rendering settings change.
  useInstancedNodes(
    graphRef,
    settings.batchedNodes,
    hiddenExts,
    settings,
    { settingsRef, healthModeRef, locModeRef, deadModeRef },
    dataGeneration,
    metricOverlayActive,
  );

  // Drag UX: dragging a node carries its descendant subtree along and locks the
  // node to its DAG level (Y) so a drag only slides it within its plane. Rides
  // the shared node-motion driver's drag callback; active regardless of the
  // batched-render toggles.
  useNodeDragBehavior(graphRef);

  // Claude agent nodes + focus beams (in-progress Claude tasks), and the
  // `W`-hold worktree-modified file outline. Both read live task data over
  // their own `/ws/tasks` subscription and draw straight into the scene.
  useAgentOverlay(graphRef, settingsRef, activeFolder);
  const { worktreeActive } = useWorktreeHighlight(
    graphRef,
    settingsRef,
    activeFolder,
    pinned.worktree,
    worktreeRingsRef,
  );

  // Search: query + regex/contents toggle state, the filename/contents passes,
  // and the prev/next match cursor are all wired together in the controller. It
  // returns the HUD-ready handlers/status/position plus the
  // `searchQuery`/`setSearchQuery`/`clearCurrentMatch` the Escape chord needs.
  const {
    searchQuery,
    setSearchQuery,
    searchRegex,
    searchContents,
    toggleSearchRegex,
    toggleSearchContents,
    handleSearchQueryChange,
    searchStatus,
    searchMatchPosition,
    goPrevMatch,
    goNextMatch,
    clearCurrentMatch,
  } = useGraphSearchController({ data, activeFolder, graphRef, setSelected, dataGeneration });

  const { contextMenu, setContextMenu } = useNodeContextMenu(containerRef);
  const closeContextMenu = useCallback(() => setContextMenu(null), [setContextMenu]);
  const { dragRect } = useBoxSelect(
    containerRef,
    graphRef,
    hiddenExtsRef,
    setSelected,
    closeContextMenu,
  );

  const {
    modalAction,
    promptText,
    setPromptText,
    submitting,
    toast,
    selectedFiles,
    openMenuItem,
    submitTask,
    closeModal,
  } = useGraphTaskCreation({
    data,
    activeFolder,
    selected,
    setSelected,
    closeContextMenu,
  });

  // Targeted halo updates — toggle the halo Sprite on only the affected node
  // ids instead of a full `graph.refresh()` (see the hook). Runtime scene sync.
  useSelectionHaloSync(graphRef, selected, settings);
  // Pulse the shared halo material (brighter/whiter ⇄ base) while any node is
  // selected so selection rings stay visible in dense graphs. O(1) per frame;
  // holds the idle controller's slow-only `halo` reason only while selected.
  useSelectionHaloPulse(graphRef, selected.size > 0);
  // Push the Rendering-tab glow knobs (strength/size) into the halo module and
  // apply changes to the current selection (strength live, size rebuilds halos).
  useSelectionGlowSettings(settings, graphRef, selected);

  // Re-render node sprites when the LOC/health ignore list changes so the new
  // filter takes effect without touching the d3 simulation (skips the mount
  // run; see the hook).
  useMetricsIgnoreRefresh(graphRef, metricsIgnoredExtsSet);

  // Escape-key behavior (close context menu → clear search → clear selection),
  // bound once and reading its branch state through refs.
  useGraphViewKeyboard({
    contextMenu,
    setContextMenu,
    modalOpen: modalAction !== null,
    searchQuery,
    setSearchQuery,
    clearCurrentMatch,
    selectedRef,
    setSelected,
  });

  // Dismiss a stuck hover tooltip when the LOC/health overlay view ends, so it
  // doesn't cling to the cursor after Z/H is released (see the hook).
  useOverlayTooltipDismiss(locMode, healthMode, cancelPendingHoverClear);

  // ----- Phase 3: render data + JSX overlays -----
  const chrome = useGraphViewChromeModel({
    containerRef,
    loading,
    data,
    structuralData,
    hiddenExts,
    activeFolder,
    history,
    range,
    setRange,
    modes: {
      healthMode,
      locMode,
      deadMode,
      labelMode,
      labelLevel,
      labelShift,
      worktreeActive,
    },
    maxDepthRef,
    maxDirDepthRef,
    selected,
    resetSelection,
    hoverNode,
    contextMenu,
    search: {
      searchQuery,
      onSearchQueryChange: handleSearchQueryChange,
      searchRegex,
      onSearchRegexToggle: toggleSearchRegex,
      searchContents,
      onSearchContentsToggle: toggleSearchContents,
      searchStatus,
      searchMatchPosition,
      onSearchPrevMatch: goPrevMatch,
      onSearchNextMatch: goNextMatch,
    },
    pinned,
    togglePin,
    dragRect,
    openMenuItem,
    taskModal: {
      action: modalAction,
      promptText,
      onPromptChange: setPromptText,
      submitting,
      selectedFiles,
      onSubmit: submitTask,
      onClose: closeModal,
    },
    toast,
    settings,
    setSettings,
    runLayout,
  });

  return <GraphViewChrome {...chrome} />;
}
