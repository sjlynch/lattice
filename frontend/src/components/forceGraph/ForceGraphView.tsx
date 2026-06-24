import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { Settings as SettingsIcon } from 'lucide-react';
import type { GraphNode, ScanResult } from '../../api';
import { GraphContextMenu } from './GraphContextMenu';
import { GraphHud } from './GraphHud';
import { GraphSelectionChip } from './GraphSelectionChip';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import { GraphTaskModal } from './GraphTaskModal';
import { TimelineScrubber } from './TimelineScrubber';
import { useStructuralScan } from '../../hooks/useStructuralScan';
import { useBoxSelect } from './hooks/useBoxSelect';
import { useAgentOverlay } from './hooks/useAgentOverlay';
import { useBatchedLinks } from './hooks/useBatchedLinks';
import { useInstancedNodes } from './hooks/useInstancedNodes';
import { useNodeDragBehavior } from './hooks/useNodeDragBehavior';
import { useForceGraphInitialization } from './hooks/useForceGraphInitialization';
import { useGraphDataSync } from './hooks/useGraphDataSync';
import { useGraphOverlays } from './hooks/useGraphOverlays';
import { useGraphSearch } from './hooks/useGraphSearch';
import { useGraphTaskCreation } from './hooks/useGraphTaskCreation';
import { useNodeContextMenu } from './hooks/useNodeContextMenu';
import { useWorktreeHighlight } from './hooks/useWorktreeHighlight';
import { useRefMirror } from './hooks/useRefMirror';
import { getIdleController } from './idleController';
import { clearLabelsAndRefresh } from './hooks/refresh';
import { applySelectionHaloDelta } from './selectionHaloSync';

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

// Hosts the 3d-force-graph instance and stitches together the per-concern
// hooks under ./hooks/: graph initialization, settings persistence, git
// timeline, LOC / health / labels overlays, shift-drag box-select, and the
// right-click "create task" menu. Render-only chrome lives in the
// Graph*.tsx siblings.
export function ForceGraphView({
  data,
  loading,
  hiddenExts,
  metricsIgnoredExts,
  activeFolder,
  healthMode,
  onHealthModeChange,
}: Props) {
  // ----- Phase 1: shared refs and overlay state -----
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchRegex, setSearchRegex] = useState(false);
  // File-contents search is opt-in — name-only is the zero-cost default.
  const [searchContents, setSearchContents] = useState(false);

  // When labels are dense or still moving the raycaster can blip in and
  // out of label hitboxes every other frame, firing `(file, null, file,
  // null, …)`. Each null transition would unmount HealthTooltip and a
  // fresh mount restarts the opacity fade-in from zero — if the flicker
  // is faster than ~80 ms the tooltip is invisible at all times. Debounce
  // null transitions so a fresh hover within the window cancels the
  // pending unmount; the user only loses the tooltip if their cursor is
  // genuinely off all labels for longer than NULL_HOVER_DEBOUNCE_MS.
  const NULL_HOVER_DEBOUNCE_MS = 220;
  const nullClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a pointer button is held down on the canvas (orbit-rotate, node
  // drag, or shift box-select). 3d-force-graph's raycaster recomputes hover on
  // EVERY render frame, so while you drag-rotate the camera, nodes sweep under
  // the cursor and `onHover` fires continuously — and each hover-in does a
  // synchronous `flushSync` React render below (plus a HealthTooltip
  // mount/unmount → Recalculate style → Layerize → Commit). That per-frame
  // churn is the rotate stutter; there's no tooltip to read mid-drag anyway, so
  // we gate hover off for the duration of the gesture (set in the pointer-drag
  // effect below).
  const pointerDraggingRef = useRef(false);
  const debouncedSetHoverNode = useCallback((node: GraphNode | null) => {
    // While dragging, ignore hover entirely. The tooltip is cleared at drag
    // start and the library re-fires hover on the first move after release.
    if (pointerDraggingRef.current) return;
    if (node !== null) {
      if (nullClearTimerRef.current) {
        clearTimeout(nullClearTimerRef.current);
        nullClearTimerRef.current = null;
      }
      // 3d-force-graph emits hover changes from its RAF, outside
      // React's event system. While the health overlay is also running
      // RAF work, normal-priority commits can be delayed until the user
      // releases `h`, which made the tooltip appear only as the mode was
      // turning off. Hover-in changes are infrequent (raycast-throttled),
      // so flush this small state update synchronously.
      flushSync(() => setHoverNode(node));
      return;
    }
    if (nullClearTimerRef.current) return;
    nullClearTimerRef.current = setTimeout(() => {
      nullClearTimerRef.current = null;
      setHoverNode(null);
    }, NULL_HOVER_DEBOUNCE_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (nullClearTimerRef.current) clearTimeout(nullClearTimerRef.current);
    };
  }, []);

  // Track pointer-drag state on the canvas to gate hover (see
  // pointerDraggingRef). pointerdown on the container starts a drag; the release
  // is bound on `window` because a fast rotate often lifts off-canvas. At drag
  // start we cancel any pending hover-clear and hide an open tooltip so it
  // doesn't sit stale over the rotating graph; the functional updater skips the
  // render when nothing was shown.
  //
  // We ALSO suspend 3d-force-graph's pointer interaction for the gesture
  // (`enablePointerInteraction(false)`). The library re-runs an O(N) hover
  // raycast — over every node incl. the invisible batched-node pick proxies —
  // on EVERY render frame (`renderObjs.tick`), and on a hover change it shows /
  // positions its own DOM tooltip element (the `Recalculate style` / `setProperty`
  // / `Layerize` churn in the trace). None of that is wanted while you rotate, so
  // disabling it for the drag removes the per-frame raycast + tooltip work. It
  // only gates hover/click; the already-constructed node-drag DragControls and
  // OrbitControls are unaffected. Re-enabled on release.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const setPointerInteraction = (on: boolean) => {
      const g = graphRef.current as unknown as {
        enablePointerInteraction?: (v: boolean) => unknown;
      } | null;
      g?.enablePointerInteraction?.(on);
    };
    const onDown = () => {
      pointerDraggingRef.current = true;
      if (nullClearTimerRef.current) {
        clearTimeout(nullClearTimerRef.current);
        nullClearTimerRef.current = null;
      }
      setHoverNode((cur) => (cur === null ? cur : null));
      setPointerInteraction(false);
    };
    const onUp = () => {
      if (!pointerDraggingRef.current) return;
      pointerDraggingRef.current = false;
      setPointerInteraction(true);
    };
    el.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      // Don't leave interaction disabled if we unmount mid-drag.
      if (pointerDraggingRef.current) setPointerInteraction(true);
    };
  }, [graphRef]);

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
  } = useGraphOverlays({
    activeFolder,
    graphRef,
    containerRef,
    data,
    hiddenExts,
    healthMode,
    onHealthModeChange,
    selected,
  });

  // Mirror of the batched-nodes toggle, read live by nodeObjectFactory to hide
  // the per-node base sprite (kept as the raycast pick proxy) — seeded from the
  // persisted setting on first render so init builds sprites at the right
  // visibility, then kept in sync for runtime toggles.
  const batchedNodesRef = useRefMirror(settings.batchedNodes);

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
    onHoverNodeChange: debouncedSetHoverNode,
  });

  const resetSelection = useCallback(() => setSelected(new Set()), []);

  useGraphDataSync({
    graphRef,
    data,
    history,
    onResetSelection: resetSelection,
    healthModeRef,
    locModeRef,
    deadModeRef,
  });

  // Batched link rendering: collapse the library's per-link Line objects into a
  // single LineSegments so orbiting a settled graph isn't E extra draw calls per
  // frame. Keyed off `structuralData` (the visible link set only changes on a
  // structural swap or a hidden-ext change, not on metric-only HealthUpdates).
  useBatchedLinks(graphRef, settings.batchedLinks, structuralData, hiddenExts);

  // Batched node rendering: draw the base node shapes as a few instanced meshes
  // (one per file type) instead of N Sprite-bearing Groups, so orbiting a
  // settled graph isn't ~N node draw calls per frame. The per-node sprite stays
  // mounted-but-invisible as the pick proxy (see nodeObjectFactory); recolor
  // overlays (health/loc/dead) fall back to the per-node path. Keyed off
  // `structuralData` for the same reason as batched links.
  useInstancedNodes(
    graphRef,
    settings.batchedNodes,
    structuralData,
    hiddenExts,
    settings,
    { settingsRef, healthModeRef, locModeRef, deadModeRef },
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
  useWorktreeHighlight(graphRef, settingsRef, activeFolder);

  // Search bar: filename matches (instant, client-side) + file-contents matches
  // (debounced backend pass) both feed the shared `selected` set, so a match
  // shows the standard selection ring.
  const searchStatus = useGraphSearch({
    data,
    activeFolder,
    query: searchQuery,
    regex: searchRegex,
    contents: searchContents,
    setSelected,
  });

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

  // Targeted halo updates — toggle the halo Sprite on only the affected
  // node ids instead of calling `graph.refresh()`, which re-runs
  // `nodeThreeObject` for every node in the scene. On a 1000-file
  // project this turns a 50–200 ms commit per click into <1 ms.
  const prevSelectedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) {
      prevSelectedRef.current = selected;
      return;
    }
    applySelectionHaloDelta(graph, prevSelectedRef.current, selected, settings);
    prevSelectedRef.current = selected;
    // Drive a few render frames so the new halo paints — the render
    // loop is otherwise paused while the engine is settled.
    getIdleController(graph)?.wakeForRefresh();
    // The halo only reads node sizes (via baseSizeFor). Narrow the deps so
    // dragging an unrelated slider (charge, link distance, label spread, …)
    // doesn't re-run the O(N) delta and wake the loop for an unchanged
    // selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, settings.fileNodeSize, settings.dirNodeSize]);

  // Same when the LOC/health ignore list changes — re-render so the new
  // filter takes effect without touching the d3 simulation. Skip the mount
  // run: the initial sprite build already reads the ignore set (threaded as
  // `metricsIgnoredExtsRef` into useForceGraphInitialization), so a refresh
  // here on first mount is a wasted full sprite rebuild + loop wake — often
  // before any data has even loaded.
  const ignoreListMountedRef = useRef(false);
  useEffect(() => {
    if (!ignoreListMountedRef.current) {
      ignoreListMountedRef.current = true;
      return;
    }
    clearLabelsAndRefresh(graphRef.current);
  }, [metricsIgnoredExtsSet]);

  // Clear selection / close context menu on Escape. Bound ONCE — the
  // branch state (contextMenu / modal / searchQuery / selection) is read
  // through refs so the listener isn't removed/re-added on every selection
  // change or search keystroke (it previously re-bound per keystroke).
  const contextMenuRef = useRefMirror(contextMenu);
  const modalActionRef = useRefMirror(modalAction);
  const searchQueryRef = useRefMirror(searchQuery);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (contextMenuRef.current) setContextMenu(null);
      else if (modalActionRef.current) {
        // Modal handles its own Escape close
      } else if (searchQueryRef.current) {
        // Clearing the query also clears its driven selection (useGraphSearch).
        setSearchQuery('');
      } else if (selectedRef.current.size > 0) {
        setSelected(new Set());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Phase 3: render data + JSX overlays -----
  // Keyed off `structuralData` (stable across metric-only saves) + `hiddenExts`,
  // so it no longer recomputes on every HealthUpdate. The ref-compare still
  // reuses the prior object when the three numbers are unchanged (e.g. a
  // same-shape rescan), so the memoized HUD doesn't re-render needlessly.
  const countsRef = useRef({ files: 0, dirs: 0, hidden: 0 });
  const counts = useMemo(() => {
    let files = 0;
    let dirs = 0;
    let hidden = 0;
    if (structuralData) {
      for (const n of structuralData.nodes) {
        if (n.kind === 'dir') {
          dirs++;
        } else {
          const key = n.ext ? n.ext.toLowerCase() : '*';
          if (hiddenExts.has(key)) hidden++;
          else files++;
        }
      }
    }
    const prev = countsRef.current;
    if (prev.files === files && prev.dirs === dirs && prev.hidden === hidden) {
      return prev;
    }
    const next = { files, dirs, hidden };
    countsRef.current = next;
    return next;
  }, [structuralData, hiddenExts]);

  // Stable handlers so the memoized HUD / search bar / timeline don't
  // re-render on every hover/search keystroke. Functional-updater form
  // keeps the deps empty.
  const toggleSearchRegex = useCallback(() => setSearchRegex((v) => !v), []);
  const toggleSearchContents = useCallback(
    () => setSearchContents((v) => !v),
    [],
  );
  const toggleSettings = useCallback(() => setShowSettings((v) => !v), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const handleRangeChange = useCallback(
    (l: number, r: number) =>
      setRange((cur) =>
        cur.left === l && cur.right === r ? cur : { left: l, right: r },
      ),
    [setRange],
  );

  // The bottom-anchored counts chip and gear FAB shift up when the
  // timeline is visible so the timeline can claim the entire viewport
  // bottom edge.
  const hasTimeline =
    !!history && history.isRepo && history.commits.length > 0;

  return (
    <div
      className={hasTimeline ? 'has-timeline' : undefined}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      <GraphHud
        loading={loading}
        hasData={!!data}
        counts={counts}
        healthMode={healthMode}
        locMode={locMode}
        deadMode={deadMode}
        labelMode={labelMode}
        labelLevel={labelLevel}
        maxDepth={labelShift ? maxDepthRef.current : maxDirDepthRef.current}
        selectionCount={selected.size}
        // Suppress the file hover tooltip while the right-click menu is open
        // so it doesn't sit over the menu. Gating (rather than a one-shot
        // clear) also keeps it from flickering back if the raycaster re-hovers
        // the still-under-cursor node while the menu is up.
        hoverNode={contextMenu ? null : hoverNode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchRegex={searchRegex}
        onSearchRegexToggle={toggleSearchRegex}
        searchContents={searchContents}
        onSearchContentsToggle={toggleSearchContents}
        searchStatus={searchStatus}
      />

      {history && history.isRepo && history.commits.length > 0 && (
        <div className="timeline-bar">
          <TimelineScrubber
            commits={history.commits}
            left={range.left}
            right={range.right}
            onChange={handleRangeChange}
            hasUncommitted={history.uncommitted.changes.length > 0}
          />
        </div>
      )}

      {dragRect && (
        <div
          className="graph-select-rect"
          style={{
            left: Math.min(dragRect.x1, dragRect.x2),
            top: Math.min(dragRect.y1, dragRect.y2),
            width: Math.abs(dragRect.x2 - dragRect.x1),
            height: Math.abs(dragRect.y2 - dragRect.y1),
          }}
        />
      )}

      <GraphSelectionChip count={selected.size} onClear={resetSelection} />

      <GraphContextMenu position={contextMenu} onPick={openMenuItem} />

      <GraphTaskModal
        action={modalAction}
        promptText={promptText}
        onPromptChange={setPromptText}
        submitting={submitting}
        selectedFiles={selectedFiles}
        rootPath={data?.root || activeFolder}
        onSubmit={submitTask}
        onClose={closeModal}
      />

      {toast && (
        <div className="graph-toast" role="status">
          {toast}
        </div>
      )}

      {showSettings && (
        <GraphSettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={closeSettings}
          project={activeFolder}
        />
      )}

      <button
        className={`graph-settings-fab${showSettings ? ' active' : ''}`}
        onClick={toggleSettings}
        aria-label="Graph settings"
        title="Graph settings"
      >
        <SettingsIcon size={16} />
      </button>
    </div>
  );
}
