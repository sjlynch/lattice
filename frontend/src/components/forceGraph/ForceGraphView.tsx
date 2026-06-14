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
import { useBoxSelect } from './hooks/useBoxSelect';
import { useAgentOverlay } from './hooks/useAgentOverlay';
import { useForceGraphInitialization } from './hooks/useForceGraphInitialization';
import { useGraphDataSync } from './hooks/useGraphDataSync';
import { useGraphOverlays } from './hooks/useGraphOverlays';
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
  const debouncedSetHoverNode = useCallback((node: GraphNode | null) => {
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

  const selectedRef = useRefMirror(selected);
  const hiddenExtsRef = useRefMirror(hiddenExts);
  const dataRef = useRefMirror(data);

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
    labelShiftRef,
    labelLevel,
    labelLevelRef,
    maxDepthRef,
    nodeDepthsRef,
  } = useGraphOverlays({
    activeFolder,
    graphRef,
    containerRef,
    data,
    hiddenExts,
    healthMode,
    onHealthModeChange,
  });

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
    onHoverNodeChange: debouncedSetHoverNode,
  });

  const resetSelection = useCallback(() => setSelected(new Set()), []);

  useGraphDataSync({
    graphRef,
    data,
    history,
    onResetSelection: resetSelection,
  });

  // Claude agent nodes + focus beams (in-progress Claude tasks), and the
  // `W`-hold worktree-modified file outline. Both read live task data over
  // their own `/ws/tasks` subscription and draw straight into the scene.
  useAgentOverlay(graphRef, settingsRef, activeFolder);
  useWorktreeHighlight(graphRef, settingsRef, activeFolder);

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
  }, [selected, settings]);

  // Same when the LOC/health ignore list changes — re-render so the new
  // filter takes effect without touching the d3 simulation.
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [metricsIgnoredExtsSet]);

  // Clear selection / close context menu on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (contextMenu) setContextMenu(null);
      else if (modalAction) {
        // Modal handles its own Escape close
      } else if (selected.size > 0) {
        setSelected(new Set());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextMenu, modalAction, selected, setContextMenu]);

  // ----- Phase 3: render data + JSX overlays -----
  const counts = useMemo(() => {
    if (!data) return { files: 0, dirs: 0, hidden: 0 };
    let files = 0;
    let dirs = 0;
    let hidden = 0;
    for (const n of data.nodes) {
      if (n.kind === 'dir') {
        dirs++;
      } else {
        const key = n.ext ? n.ext.toLowerCase() : '*';
        if (hiddenExts.has(key)) hidden++;
        else files++;
      }
    }
    return { files, dirs, hidden };
  }, [data, hiddenExts]);

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
        data={data}
        counts={counts}
        healthMode={healthMode}
        locMode={locMode}
        deadMode={deadMode}
        labelMode={labelMode}
        labelLevel={labelLevel}
        maxDepth={maxDepthRef.current}
        hoverNode={hoverNode}
      />

      {history && history.isRepo && history.commits.length > 0 && (
        <div className="timeline-bar">
          <TimelineScrubber
            commits={history.commits}
            left={range.left}
            right={range.right}
            onChange={(l, r) =>
              setRange((cur) =>
                cur.left === l && cur.right === r ? cur : { left: l, right: r },
              )
            }
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
          onClose={() => setShowSettings(false)}
        />
      )}

      <button
        className={`graph-settings-fab${showSettings ? ' active' : ''}`}
        onClick={() => setShowSettings((v) => !v)}
        aria-label="Graph settings"
        title="Graph settings"
      >
        <SettingsIcon size={16} />
      </button>
    </div>
  );
}
