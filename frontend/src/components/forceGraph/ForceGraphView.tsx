import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { Settings as SettingsIcon } from 'lucide-react';
import {
  createTask,
  type GraphNode,
  type ScanResult,
} from '../../api';
import { Modal } from '../Modal';
import { buildGhostGraphData } from './timelineDiff';
import { TimelineScrubber } from './TimelineScrubber';
import { locLabelRegistry } from './locOverlay';
import { labelsRegistry } from './labelsOverlay';
import { healthLabelRegistry } from './healthOverlay';
import { HealthTooltip } from './HealthTooltip';
import { MENU_ITEMS, relPath, type MenuItemDef } from './menu';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import { useRefMirror } from './hooks/useRefMirror';
import { useBoxSelect } from './hooks/useBoxSelect';
import { useNodeContextMenu } from './hooks/useNodeContextMenu';
import { useHoverCursor } from './hooks/useHoverCursor';
import { clearLabelsAndRefresh } from './hooks/refresh';
import { useForceGraphInitialization } from './hooks/useForceGraphInitialization';
import { useGraphOverlayState } from './hooks/useGraphOverlayState';
import { useGraphOverlays } from './hooks/useGraphOverlays';

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
// right-click "create task" menu.
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
  const ghostsRef = useRef<Set<string>>(new Set());

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRefMirror(selected);
  const hiddenExtsRef = useRefMirror(hiddenExts);
  const dataRef = useRefMirror(data);
  const [showSettings, setShowSettings] = useState(false);

  const {
    hoverNode,
    setHoverNode,
    modalAction,
    setModalAction,
    promptText,
    setPromptText,
    submitting,
    setSubmitting,
    toast,
    setToast,
  } = useGraphOverlayState();

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

  const { contextMenu, setContextMenu } = useNodeContextMenu(containerRef);
  const closeContextMenu = useCallback(() => setContextMenu(null), [setContextMenu]);
  const { dragRect } = useBoxSelect(
    containerRef,
    graphRef,
    hiddenExtsRef,
    setSelected,
    closeContextMenu,
  );

  // Push the full dataset only when the scan or git history changes.
  // Ghost nodes (deleted files surfaced from git history) are merged
  // into graphData here so the physics simulation places them once;
  // scrubbing the timeline only flips visibility/rings afterward and
  // never causes a graphData restart.
  useEffect(() => {
    if (!graphRef.current) return;
    // Stale labels reference Sprites that get replaced on data swap.
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    if (!data) {
      graphRef.current.graphData({ nodes: [], links: [] });
      ghostsRef.current = new Set();
      return;
    }
    const ghostIds = new Set<string>();
    let ghostNodes: GraphNode[] = [];
    let ghostLinks: { source: string; target: string }[] = [];
    if (history && history.isRepo) {
      const built = buildGhostGraphData(data, history.commits, history.uncommitted);
      ghostNodes = built.ghostNodes;
      ghostLinks = built.ghostLinks;
      for (const g of built.ghostNodes) ghostIds.add(g.id);
    }
    ghostsRef.current = ghostIds;
    graphRef.current.graphData({
      nodes: [...data.nodes, ...ghostNodes],
      links: [...data.links, ...ghostLinks],
    });
    // A new scan invalidates the previous selection (node IDs may differ).
    setSelected(new Set());
  }, [data, history]);

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

  // Files actually selected (filter out anything no longer in the dataset)
  const selectedFiles = useMemo(() => {
    if (!data || selected.size === 0) return [] as GraphNode[];
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const out: GraphNode[] = [];
    for (const id of selected) {
      const n = byId.get(id);
      if (n) out.push(n);
    }
    return out;
  }, [data, selected]);

  const openMenuItem = useCallback((item: MenuItemDef) => {
    setContextMenu(null);
    setPromptText(item.prefill);
    setModalAction(item);
  }, [setContextMenu, setModalAction, setPromptText]);

  const submitTask = useCallback(async () => {
    if (!modalAction || !activeFolder) return;
    const trimmed = promptText.trim();
    if (!trimmed) return;
    const titleSnippet = trimmed.replace(/\s+/g, ' ').slice(0, 60);
    const title = `${modalAction.verb}: ${titleSnippet}`;
    const root = data?.root || activeFolder;
    const fileLines = selectedFiles
      .map((n) => `- ${relPath(n.path, root)}`)
      .join('\n');
    const description = `${trimmed}\n\n## Files\n${fileLines}`;
    setSubmitting(true);
    try {
      await createTask(activeFolder, title, description);
      setToast('Task created — open the board to run it');
      setSelected(new Set());
      setModalAction(null);
      setPromptText('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast(`Failed to create task: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }, [
    modalAction,
    promptText,
    activeFolder,
    data,
    selectedFiles,
    setModalAction,
    setPromptText,
    setSubmitting,
    setToast,
  ]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setModalAction(null);
    setPromptText('');
  }, [submitting, setModalAction, setPromptText]);

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
      {loading && (
        <div className="graph-overlay top-left">
          <span className="spinner" />
          <span>Scanning…</span>
        </div>
      )}
      {healthMode && (
        <div className="loc-view-chip">View: Code Health</div>
      )}
      {locMode && !healthMode && (
        <div className="loc-view-chip">View: Lines of Code</div>
      )}
      {labelMode && !locMode && !healthMode && (
        <div className="loc-view-chip">
          View: Labels · depth {labelLevel}
          {maxDepthRef.current > 0 && ` / ${maxDepthRef.current}`}
          <span style={{ opacity: 0.7, marginLeft: 8 }}>
            (alt+wheel to scroll)
          </span>
        </div>
      )}
      {hoverNode && hoverPos && (
        <HealthTooltip node={hoverNode} x={hoverPos.x} y={hoverPos.y} />
      )}
      {!loading && data && (
        <div className="graph-overlay bottom-left">
          <span>
            {counts.files} files · {counts.dirs} dirs
            {counts.hidden > 0 && (
              <span style={{ color: 'var(--text-tertiary)' }}>
                {' '}
                · {counts.hidden} hidden
              </span>
            )}
          </span>
        </div>
      )}

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

      {selected.size > 0 && (
        <div className="graph-selection-chip">
          <span>
            {selected.size} {selected.size === 1 ? 'file' : 'files'} selected
          </span>
          <span className="sep">·</span>
          <button
            className="link-btn"
            onClick={() => setSelected(new Set())}
            title="Clear selection (Esc)"
          >
            clear
          </button>
        </div>
      )}

      {contextMenu && (
        <div
          className="popover graph-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {MENU_ITEMS.map((item) => (
            <div
              key={item.verb}
              className="popover-item"
              role="menuitem"
              onClick={() => openMenuItem(item)}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}

      <Modal open={!!modalAction} onClose={closeModal}>
        <div className="modal-header">
          {modalAction?.label.replace(/…$/, '')} ({selectedFiles.length}{' '}
          {selectedFiles.length === 1 ? 'file' : 'files'})
        </div>
        <div className="modal-body">
          <textarea
            className="task-card-form-textarea"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder="Describe what Claude should do…"
            rows={6}
            autoFocus
          />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            Files (relative to project root):
          </div>
          <div
            style={{
              maxHeight: 160,
              overflow: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 8px',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              background: '#15181d',
            }}
          >
            {selectedFiles.length === 0 ? (
              <em>No files selected.</em>
            ) : (
              selectedFiles.map((n) => (
                <div key={n.id}>{relPath(n.path, data?.root || activeFolder)}</div>
              ))
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={closeModal} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={submitTask}
            disabled={submitting || !promptText.trim() || selectedFiles.length === 0}
          >
            {submitting ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </Modal>

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
