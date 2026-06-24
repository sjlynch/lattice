import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { Settings as SettingsIcon } from 'lucide-react';
import type { ScanResult } from '../../api';
import { GraphContextMenu } from './GraphContextMenu';
import { GraphHud } from './GraphHud';
import { GraphOverlayKey } from './GraphOverlayKey';
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
import { useHoverNodeDebounce } from './hooks/useHoverNodeDebounce';
import { useCanvasDragTracking } from './hooks/useCanvasDragTracking';
import { useRefMirror } from './hooks/useRefMirror';
import { getIdleController } from './idleController';
import { clearLabelsAndRefresh } from './hooks/refresh';
import { applySelectionHaloDelta } from './selectionHaloSync';
import { mountedNodesById } from './mountedNodes';

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

// Camera fly duration when stepping to a search match, and the cadence we
// re-wake the render loop at while it animates. The library steps its camera
// tween inside the render frame (`tweenGroup.update` in three-render-objects'
// `tick`), which the idle controller pauses once the scene settles — so a
// programmatic focus must keep the loop awake for the whole transition.
// `wakeForRefresh` holds it only ~120 ms, hence the pulse < that interval.
const CAMERA_FOCUS_MS = 450;
const CAMERA_FOCUS_PULSE_MS = 100;

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
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchRegex, setSearchRegex] = useState(false);
  // File-contents search is opt-in — name-only is the zero-cost default.
  const [searchContents, setSearchContents] = useState(false);

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
  const { worktreeActive } = useWorktreeHighlight(
    graphRef,
    settingsRef,
    activeFolder,
    pinned.worktree,
  );

  // Search bar: filename matches (instant, client-side) + file-contents matches
  // (debounced backend pass) both feed the shared `selected` set, so a match
  // shows the standard selection ring. `searchMatches` is the ordered id list
  // backing prev/next match navigation.
  const { status: searchStatus, matches: searchMatches } = useGraphSearch({
    data,
    activeFolder,
    query: searchQuery,
    regex: searchRegex,
    contents: searchContents,
    setSelected,
  });

  // Prev/next match navigation. The current match is tracked by *id* (not a
  // numeric index), so its "X of Y" position derives straight from the live
  // match list — when the set changes under us (the contents pass landing, a
  // file rename) a dropped id simply reads as "no current match", no reset
  // bookkeeping. Stepping recenters the camera on the match's node (already
  // ringed as a member of `selected`). The list is read through a ref so the
  // step handlers stay referentially stable (keeping the memoized HUD off the
  // per-keystroke render path). A fresh query clears the cursor via
  // `handleSearchQueryChange` below.
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  const searchMatchesRef = useRefMirror(searchMatches);

  // Pan the camera to center a match's node, preserving the current viewing
  // angle + distance (translate camera by the same delta as the orbit target).
  const cameraPulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const focusNodeById = useCallback((nodeId: string) => {
    const graph = graphRef.current;
    if (!graph) return;
    const node = mountedNodesById(graph).get(nodeId) as
      | { x?: number; y?: number; z?: number }
      | undefined;
    if (!node) return;
    const { x, y, z } = node;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
      return;
    }
    const camera = graph.camera();
    const controls = graph.controls() as { target?: { x: number; y: number; z: number } };
    const target = controls?.target;
    if (camera && target) {
      const dx = x - target.x;
      const dy = y - target.y;
      const dz = z - target.z;
      graph.cameraPosition(
        { x: camera.position.x + dx, y: camera.position.y + dy, z: camera.position.z + dz },
        { x, y, z },
        CAMERA_FOCUS_MS,
      );
    } else {
      graph.cameraPosition({}, { x, y, z }, CAMERA_FOCUS_MS);
    }
    // Keep the render loop awake so the camera tween actually advances (the
    // idle controller pauses it once settled). Pulse the refresh wake faster
    // than its ~120 ms hold for the transition, then let it settle on its own.
    const idle = getIdleController(graph);
    if (idle) {
      if (cameraPulseRef.current) clearInterval(cameraPulseRef.current);
      idle.wakeForRefresh();
      let elapsed = 0;
      cameraPulseRef.current = setInterval(() => {
        elapsed += CAMERA_FOCUS_PULSE_MS;
        idle.wakeForRefresh();
        if (elapsed >= CAMERA_FOCUS_MS && cameraPulseRef.current) {
          clearInterval(cameraPulseRef.current);
          cameraPulseRef.current = null;
        }
      }, CAMERA_FOCUS_PULSE_MS);
    }
  }, []);
  useEffect(
    () => () => {
      if (cameraPulseRef.current) clearInterval(cameraPulseRef.current);
    },
    [],
  );

  // Pure id step (no side effect in the updater, so it's safe under batching /
  // StrictMode): wrap-around from the current match, or start at the first/last
  // when there's none. The camera follow runs in the effect below, off the
  // committed id — so a rapid double-step animates once to the final match
  // instead of fighting two tweens.
  const stepMatch = useCallback(
    (delta: number) => {
      setCurrentMatchId((curId) => {
        const list = searchMatchesRef.current;
        if (list.length === 0) return null;
        const cur = curId ? list.indexOf(curId) : -1;
        const next =
          cur < 0
            ? delta > 0
              ? 0
              : list.length - 1
            : (cur + delta + list.length) % list.length;
        return list[next];
      });
    },
    [searchMatchesRef],
  );
  useEffect(() => {
    if (currentMatchId) focusNodeById(currentMatchId);
  }, [currentMatchId, focusNodeById]);
  const goPrevMatch = useCallback(() => stepMatch(-1), [stepMatch]);
  const goNextMatch = useCallback(() => stepMatch(1), [stepMatch]);
  // 1-based position of the current match in the live list (0 = none / dropped).
  const searchMatchPosition = useMemo(() => {
    if (!currentMatchId) return 0;
    const i = searchMatches.indexOf(currentMatchId);
    return i >= 0 ? i + 1 : 0;
  }, [searchMatches, currentMatchId]);

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
        // Clearing the query also clears its driven selection (useGraphSearch)
        // and the match-navigation cursor.
        setSearchQuery('');
        setCurrentMatchId(null);
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
  // Any query change is a fresh search, so drop the current-match cursor (the
  // "X of Y" only reappears once the user steps again). Stable — both setters
  // are stable, so the memoized HUD stays off the per-keystroke render path.
  const handleSearchQueryChange = useCallback((q: string) => {
    setSearchQuery(q);
    setCurrentMatchId(null);
  }, []);
  const toggleSettings = useCallback(() => setShowSettings((v) => !v), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const handleRangeChange = useCallback(
    (l: number, r: number) =>
      setRange((cur) =>
        cur.left === l && cur.right === r ? cur : { left: l, right: r },
      ),
    [setRange],
  );

  // Which overlay views are currently *showing* (held OR pinned), for the
  // overlay-key chips' lit "active" state. `healthMode` is the App-owned
  // effective value (already composed in useHealthOverlay); the rest come back
  // from useGraphOverlays / useWorktreeHighlight already folded with their pins.
  const overlayActive = useMemo(
    () => ({
      health: healthMode,
      loc: locMode,
      dead: deadMode,
      worktree: worktreeActive,
      labels: labelMode,
    }),
    [healthMode, locMode, deadMode, worktreeActive, labelMode],
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
        onSearchQueryChange={handleSearchQueryChange}
        searchRegex={searchRegex}
        onSearchRegexToggle={toggleSearchRegex}
        searchContents={searchContents}
        onSearchContentsToggle={toggleSearchContents}
        searchStatus={searchStatus}
        searchMatchPosition={searchMatchPosition}
        onSearchPrevMatch={goPrevMatch}
        onSearchNextMatch={goNextMatch}
      />

      {/* Always-visible key for the hold-key overlays (top-left). Each chip
          documents a view + shortcut and pins it on click. Gated on loaded data
          so it never overlaps the top-left scan spinner (loading is true only
          while data is null). */}
      {!!data && (
        <GraphOverlayKey
          pinned={pinned}
          active={overlayActive}
          onTogglePin={togglePin}
        />
      )}

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
