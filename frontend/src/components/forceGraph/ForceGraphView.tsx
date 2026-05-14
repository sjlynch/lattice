import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useForceGraphInitialization } from './hooks/useForceGraphInitialization';
import { useGraphDataSync } from './hooks/useGraphDataSync';
import { useGraphOverlays } from './hooks/useGraphOverlays';
import { useGraphTaskCreation } from './hooks/useGraphTaskCreation';
import { useHoverCursor } from './hooks/useHoverCursor';
import { useNodeContextMenu } from './hooks/useNodeContextMenu';
import { useRefMirror } from './hooks/useRefMirror';
import { clearLabelsAndRefresh } from './hooks/refresh';

type Props = {
  data: ScanResult | null;
  loading: boolean;
  hiddenExts: Set<string>;
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

  const selectedRef = useRefMirror(selected);
  const hiddenExtsRef = useRefMirror(hiddenExts);
  const dataRef = useRefMirror(data);

  const { hoverPos } = useHoverCursor(containerRef);

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
    labelMode,
    labelModeRef,
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
    labelModeRef,
    labelLevelRef,
    nodeDepthsRef,
    changeMapRef,
    onHoverNodeChange: setHoverNode,
  });

  const resetSelection = useCallback(() => setSelected(new Set()), []);

  useGraphDataSync({
    graphRef,
    data,
    history,
    onResetSelection: resetSelection,
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

  // Re-render node THREE objects when the selection changes so halos
  // update. refresh() re-evaluates nodeThreeObject without restarting
  // the d3 simulation, so node positions stay put.
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [selected]);

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
        labelMode={labelMode}
        labelLevel={labelLevel}
        maxDepth={maxDepthRef.current}
        hoverNode={hoverNode}
        hoverPos={hoverPos}
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
