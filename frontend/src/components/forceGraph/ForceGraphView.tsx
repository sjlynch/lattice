import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { Settings as SettingsIcon } from 'lucide-react';
import {
  createTask,
  type GraphNode,
  type ScanResult,
} from '../../api';
import { Modal } from '../Modal';
import { spriteFor } from './sprites';
import { withHalo } from './halo';
import { deletedSprite, withChangeRing } from './changeRing';
import { buildGhostGraphData, isGhost, relForward } from './timelineDiff';
import { TimelineScrubber } from './TimelineScrubber';
import { locLabelRegistry, spriteForLoc } from './locOverlay';
import { labelsRegistry, spriteForLabels } from './labelsOverlay';
import { healthLabelRegistry, spriteForHealth } from './healthOverlay';
import { HealthTooltip } from './HealthTooltip';
import { MENU_ITEMS, relPath, type MenuItemDef } from './menu';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import { useRefMirror } from './hooks/useRefMirror';
import { useGraphSettings } from './hooks/useGraphSettings';
import { useGitTimeline } from './hooks/useGitTimeline';
import { useLocOverlay } from './hooks/useLocOverlay';
import { useHealthOverlay } from './hooks/useHealthOverlay';
import { useLabelsOverlay } from './hooks/useLabelsOverlay';
import { useBoxSelect } from './hooks/useBoxSelect';
import { useNodeContextMenu } from './hooks/useNodeContextMenu';
import { useGraphFilter } from './hooks/useGraphFilter';
import { useHoverCursor } from './hooks/useHoverCursor';
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
// hooks under ./hooks/: settings persistence, git timeline, the LOC / health /
// labels overlays, shift-drag box-select, and the right-click "create task"
// menu. The mount effect below is the only place THREE.js is wired up.
export function ForceGraphView({
  data,
  loading,
  hiddenExts,
  activeFolder,
  healthMode,
  onHealthModeChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);

  // Currently-hovered file node. While healthMode is on, a tooltip in
  // the parent div shows its score + breakdown.
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
  const { hoverPos } = useHoverCursor(containerRef);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRefMirror(selected);
  const hiddenExtsRef = useRefMirror(hiddenExts);
  const dataRef = useRefMirror(data);

  const { settings, setSettings, settingsRef } = useGraphSettings(
    activeFolder,
    graphRef,
  );
  const [showSettings, setShowSettings] = useState(false);

  const { history, range, setRange, changeMapRef } = useGitTimeline(
    activeFolder,
    graphRef,
  );

  const { locMode, locModeRef } = useLocOverlay(graphRef, settingsRef);
  const { healthModeRef } = useHealthOverlay(
    healthMode,
    onHealthModeChange,
    graphRef,
    settingsRef,
  );
  const {
    labelMode,
    labelModeRef,
    labelLevel,
    labelLevelRef,
    maxDepthRef,
    nodeDepthsRef,
  } = useLabelsOverlay(graphRef, containerRef, data, settingsRef);

  const { contextMenu, setContextMenu } = useNodeContextMenu(containerRef);
  const closeContextMenu = useCallback(() => setContextMenu(null), [setContextMenu]);
  const { dragRect } = useBoxSelect(
    containerRef,
    graphRef,
    hiddenExtsRef,
    setSelected,
    closeContextMenu,
  );

  const ghostsRef = useRef<Set<string>>(new Set());

  const [modalAction, setModalAction] = useState<MenuItemDef | null>(null);
  const [promptText, setPromptText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ---------- Mount: graph + camera + resize observer ----------
  useEffect(() => {
    if (!containerRef.current) return;
    const graph = new ForceGraph3D(containerRef.current, {
      controlType: 'orbit',
    })
      .backgroundColor('#1a1d22')
      .nodeId('id')
      .nodeLabel((n: object) => {
        const node = n as GraphNode;
        // For files we always show our richer HealthTooltip on hover
        // (regardless of whether the `h` key is held), so suppress the
        // library's native label here to avoid stacking two tooltips
        // on top of each other. Directories don't have health data,
        // so they keep the simple library tooltip.
        if (node.kind === 'file') return '';
        return `📁 ${node.name}`;
      })
      .nodeThreeObject((n: object) => {
        const node = n as GraphNode;
        const s = settingsRef.current;
        const baseSize = node.kind === 'dir' ? s.dirNodeSize : s.fileNodeSize;

        // Ghost nodes (deleted files surfaced from git history) only
        // exist in the graph because the scrubber range picks up a
        // delete event somewhere — render them as a small grey disc
        // with a red ring instead of running spriteFor on a path that
        // has no real file behind it.
        if (isGhost(node)) {
          let obj: THREE.Object3D = deletedSprite(s.fileNodeSize);
          if (selectedRef.current.has(node.id)) {
            obj = withHalo(obj, s.fileNodeSize);
          }
          return obj;
        }

        let obj: THREE.Object3D;
        if (healthModeRef.current) {
          obj = spriteForHealth(node, s);
        } else if (locModeRef.current) {
          obj = spriteForLoc(node, s);
        } else if (labelModeRef.current) {
          const d = nodeDepthsRef.current.get(node.id) ?? 0;
          obj = spriteForLabels(node, s, labelLevelRef.current, d);
        } else {
          obj = spriteFor(node, s);
        }
        // Apply change ring before halo so the selection halo always
        // wraps the outermost layer.
        const root = dataRef.current?.root || '';
        const rel = node.kind === 'file' ? relForward(node.path, root) : '';
        const kind = rel ? changeMapRef.current.get(rel) : undefined;
        if (kind && kind !== 'deleted') {
          obj = withChangeRing(obj, baseSize, kind);
        }
        if (selectedRef.current.has(node.id)) {
          return withHalo(obj, baseSize);
        }
        return obj;
      })
      .nodeRelSize(1)
      .linkColor(() => 'rgba(220,228,240,0.55)')
      .linkOpacity(0.85)
      .linkWidth(0.7)
      .dagMode('td')
      .dagLevelDistance(settingsRef.current.dagLevelDistance)
      .showNavInfo(false)
      .onNodeHover((n: object | null) => {
        // Track the hovered file node so HealthTooltip can render its
        // breakdown panel. Directories don't have health metrics, so
        // they never trigger the tooltip even though the listener still
        // fires for them.
        if (!n) {
          setHoverNode(null);
          return;
        }
        const node = n as GraphNode;
        if (node.kind !== 'file' || node.healthDetails == null) {
          setHoverNode(null);
          return;
        }
        setHoverNode(node);
      })
      .onNodeRightClick((_n: object, ev: MouseEvent) => {
        // The container-level contextmenu listener already opens the menu;
        // just suppress the browser's native menu here too in case the
        // canvas event bubbles differently.
        ev.preventDefault();
      });

    graphRef.current = graph;

    // Lock the world up vector so the camera and any look-at animation
    // (computeLookAtQuaternion etc.) treat +Y as up — prevents 180° flips.
    graph.camera().up.set(0, 1, 0);

    const controls = graph.controls() as {
      minPolarAngle: number;
      maxPolarAngle: number;
      enableRotate?: boolean;
      update?: () => void;
    };
    if (controls) {
      // Camera can swing from straight overhead all the way down to ~45°
      // below horizon (PI * 0.75 ≈ 135° from +Y), enough to peek up at the
      // graph from underneath without ever flipping the root to the bottom.
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI * 0.75;
      controls.update?.();
    }

    const onResize = () => {
      if (!containerRef.current) return;
      graph.width(containerRef.current.clientWidth);
      graph.height(containerRef.current.clientHeight);
    };
    onResize();
    // Debounce so a sidebar drag (60+ events/sec) only triggers one Three.js
    // resize per settled frame rather than thrashing the GPU every pixel.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(onResize, 150);
    });
    ro.observe(containerRef.current);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      graph._destructor?.();
      graphRef.current = null;
    };
  }, []);

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

  useGraphFilter(graphRef, hiddenExts, data, history, range, changeMapRef);

  // Auto-dismiss toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(id);
  }, [toast]);

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
  }, [setContextMenu]);

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
  }, [modalAction, promptText, activeFolder, data, selectedFiles]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setModalAction(null);
    setPromptText('');
  }, [submitting]);

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
