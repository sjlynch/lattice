import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { Settings as SettingsIcon } from 'lucide-react';
import {
  createTask,
  fetchGitHistory,
  type GitHistoryResult,
  type GraphNode,
  type ScanResult,
} from '../../api';
import { Modal } from '../Modal';
import { spriteFor } from './sprites';
import { withHalo } from './halo';
import { deletedSprite, withChangeRing, type ChangeKind } from './changeRing';
import {
  buildGhostGraphData,
  computeChangeMap,
  isGhost,
  relForward,
} from './timelineDiff';
import { TimelineScrubber } from './TimelineScrubber';
import { locLabelRegistry, spriteForLoc } from './locOverlay';
import { depthFor, labelsRegistry, spriteForLabels } from './labelsOverlay';
import { healthLabelRegistry, spriteForHealth } from './healthOverlay';
import { HealthTooltip } from './HealthTooltip';
import { repelLabels } from './labelRepulsion';
import { MENU_ITEMS, relPath, type MenuItemDef } from './menu';
import { loadSettings, type GraphSettings } from './graphSettings';
import { GraphSettingsPanel } from './GraphSettingsPanel';

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

type DragRect = { x1: number; y1: number; x2: number; y2: number };

// Hosts the 3d-force-graph instance, the LOC overlay (`z` keypress), the
// shift-drag box-select, the right-click "create task" menu, and the
// settings panel. Each of those concerns is split into a useEffect below.
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

  // Lines-of-code overlay: active while the user holds `z`. Tracked in
  // both state (for the chip overlay) and a ref (so the nodeThreeObject
  // accessor — wired into the graph once at mount — reads the live value).
  const [locMode, setLocMode] = useState(false);
  const locModeRef = useRef(false);
  // Code-health overlay: active while the user holds `h`. State is owned
  // by App (so the Legend can react), but mirrored to a ref here so the
  // nodeThreeObject closure reads the live value.
  const healthModeRef = useRef(false);
  // Currently-hovered file node. While healthMode is on, a tooltip in
  // the parent div shows its score + breakdown.
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Labels overlay: active while the user holds Alt. Shows the name of every
  // node at `labelLevel` (path depth from the scan root); alt+wheel scrolls
  // through depths so the user can read one band at a time.
  const [labelMode, setLabelMode] = useState(false);
  const labelModeRef = useRef(false);
  const [labelLevel, setLabelLevel] = useState(1);
  const labelLevelRef = useRef(1);
  const maxDepthRef = useRef(0);
  const nodeDepthsRef = useRef<Map<string, number>>(new Map());

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRef<Set<string>>(new Set());
  const hiddenExtsRef = useRef<Set<string>>(hiddenExts);

  // Graph render + physics settings, persisted per project. The ref keeps
  // the latest value visible to THREE callbacks (nodeThreeObject is wired
  // once at mount) while the state drives the panel UI.
  const [settings, setSettings] = useState<GraphSettings>(() =>
    loadSettings(activeFolder),
  );
  const settingsRef = useRef<GraphSettings>(settings);
  const [showSettings, setShowSettings] = useState(false);

  // ---------- Git timeline scrubber ----------
  // History is fetched once per project; the scrubber range is two
  // tick indices into [0, commits.length], where commits.length is
  // the working-tree slot. Defaults to [oldest, WT] so the user sees
  // every change ringed when they land on the project.
  const [history, setHistory] = useState<GitHistoryResult | null>(null);
  const [range, setRange] = useState<{ left: number; right: number }>({ left: 0, right: 0 });
  // changeMap (rel-path → kind) is recomputed on every range/history
  // change. Stored in a ref so the nodeThreeObject closure (wired once
  // at mount) reads the latest map without forcing a re-mount.
  const changeMapRef = useRef<Map<string, ChangeKind>>(new Map());
  const ghostsRef = useRef<Set<string>>(new Set()); // node IDs of ghost nodes
  const dataRef = useRef<ScanResult | null>(null);

  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [modalAction, setModalAction] = useState<MenuItemDef | null>(null);
  const [promptText, setPromptText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { locModeRef.current = locMode; }, [locMode]);
  useEffect(() => { healthModeRef.current = healthMode; }, [healthMode]);
  useEffect(() => { labelModeRef.current = labelMode; }, [labelMode]);
  useEffect(() => { labelLevelRef.current = labelLevel; }, [labelLevel]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { hiddenExtsRef.current = hiddenExts; }, [hiddenExts]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { dataRef.current = data; }, [data]);

  // Reload persisted settings when the active project changes.
  useEffect(() => {
    setSettings(loadSettings(activeFolder));
  }, [activeFolder]);

  // Fetch the last 10 commits + uncommitted status whenever the active
  // project changes. The scrubber drives ring colors and ghost-node
  // visibility from the cached result — no per-drag backend traffic.
  useEffect(() => {
    if (!activeFolder) {
      setHistory(null);
      setRange({ left: 0, right: 0 });
      return;
    }
    let cancelled = false;
    fetchGitHistory(activeFolder, 10)
      .then((h) => {
        if (cancelled) return;
        setHistory(h);
        // Default to the full range so every change in the loaded
        // window is visible at first paint.
        const last = h.commits.length; // tick index of working-tree slot
        setRange({ left: 0, right: last });
      })
      .catch(() => {
        if (cancelled) return;
        setHistory({ isRepo: false, commits: [], uncommitted: { changes: [] } });
      });
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  // Persist settings whenever they change.
  useEffect(() => {
    if (!activeFolder) return;
    try {
      localStorage.setItem(
        `lattice.graphSettings.${activeFolder}`,
        JSON.stringify(settings),
      );
    } catch {
      /* ignore quota */
    }
  }, [activeFolder, settings]);

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

    // Right-click anywhere over the graph viewport opens our popover.
    // Coords are stored relative to the container because the popover is
    // rendered inside the (position: relative) wrapper and `.popover` falls
    // back to position: absolute, so viewport coords would land offset by
    // the sidebar/topbar.
    //
    // Right-drag pans the camera (OrbitControls); the browser still fires
    // `contextmenu` on release, and we want the menu only on a real click.
    // The two reliable pieces:
    //
    //   1. mousedown/mouseup positions captured at window level in capture
    //      phase. mousedown/mouseup are compat events that fire for
    //      pointerType=mouse regardless of pointer preventDefault, and
    //      window-capture beats anything inside the canvas tree to the
    //      event. Compare the two at contextmenu time; if the cursor moved
    //      more than DRAG_THRESHOLD between them, it was a pan.
    //
    //   2. The contextmenu handler also lives on window (capture), gated
    //      on containerRef.current.contains(e.target). A previous version
    //      attached it to the container; cleanup used
    //      `containerRef.current?.removeEventListener(...)`, and the
    //      optional chaining silently no-op'd across React StrictMode's
    //      mount/cleanup/remount cycle, leaking an old closure with a
    //      stale rightUpAt that opened the menu after every right-drag.
    const DRAG_THRESHOLD = 5;
    let rightDownX = 0;
    let rightDownY = 0;
    let rightUpX = 0;
    let rightUpY = 0;
    let rightUpAt = 0;
    const onMouseDownWin = (e: MouseEvent) => {
      if (e.button !== 2) return;
      rightDownX = e.clientX;
      rightDownY = e.clientY;
    };
    const onMouseUpWin = (e: MouseEvent) => {
      if (e.button !== 2) return;
      rightUpX = e.clientX;
      rightUpY = e.clientY;
      rightUpAt = performance.now();
    };
    const onCtxMenu = (e: MouseEvent) => {
      const container = containerRef.current;
      const target = e.target as Node | null;
      if (!container || !target || !container.contains(target)) return;
      e.preventDefault();
      // Recency check so keyboard contextmenu (Shift+F10, menu key) — which
      // has no paired mouseup — still opens the menu.
      if (performance.now() - rightUpAt < 500) {
        const dx = rightUpX - rightDownX;
        const dy = rightUpY - rightDownY;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      }
      const rect = container.getBoundingClientRect();
      setContextMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    window.addEventListener('mousedown', onMouseDownWin, { capture: true });
    window.addEventListener('mouseup', onMouseUpWin, { capture: true });
    window.addEventListener('contextmenu', onCtxMenu, { capture: true });

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      window.removeEventListener('mousedown', onMouseDownWin, { capture: true });
      window.removeEventListener('mouseup', onMouseUpWin, { capture: true });
      window.removeEventListener('contextmenu', onCtxMenu, { capture: true });
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
    // Recompute path depths for the labels overlay, plus the max depth so
    // alt+wheel can clamp to the visible range.
    const depths = new Map<string, number>();
    let maxD = 0;
    for (const n of data.nodes) {
      const d = depthFor(n, data.root);
      depths.set(n.id, d);
      if (d > maxD) maxD = d;
    }
    nodeDepthsRef.current = depths;
    maxDepthRef.current = maxD;
    setLabelLevel((lvl) => Math.min(Math.max(lvl, 1), Math.max(1, maxD)));
    // A new scan invalidates the previous selection (node IDs may differ).
    setSelected(new Set());
  }, [data, history]);

  // ---------- LOC overlay key handling ----------
  // Toggle LOC view on/off when the `z` key is held. Keyup also fires on
  // window blur (Alt-Tab, dev-tools focus) — we can't trust `keyup` alone,
  // so reset on blur and on visibility loss as well.
  useEffect(() => {
    function isTextInput(target: EventTarget | null) {
      if (!target) return false;
      const el = target as HTMLElement;
      const tag = el.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'z' && e.key !== 'Z') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      setLocMode(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'z' || e.key === 'Z') setLocMode(false);
    }
    function reset() {
      setLocMode(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);

  // Re-render node THREE objects when the LOC overlay or selection
  // changes. refresh() re-evaluates nodeThreeObject without restarting
  // the d3 simulation, so node positions stay put.
  useEffect(() => {
    // Old labels become orphaned when nodeThreeObject is re-evaluated;
    // spriteForLoc repopulates the registry on the way through.
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    graphRef.current?.refresh?.();
  }, [locMode, selected]);

  // ---------- Health overlay key handling ----------
  // Toggle health view on/off when the `h` key is held. Same chord
  // pattern as `z` (LOC) — keyup, blur, and visibility-change all reset
  // so we can't get stuck in an "always on" state if the user
  // alt-tabs while holding the key.
  useEffect(() => {
    function isTextInput(target: EventTarget | null) {
      if (!target) return false;
      const el = target as HTMLElement;
      const tag = el.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'h' && e.key !== 'H') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      onHealthModeChange(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'h' || e.key === 'H') onHealthModeChange(false);
    }
    function reset() {
      onHealthModeChange(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [onHealthModeChange]);

  // Refresh sprites + drop the previous overlay's labels when the
  // health overlay toggles. Same shape as the `locMode` effect above.
  // (We deliberately do NOT clear `hoverNode` here — the tooltip is
  // shown for every file hover regardless of the `h` key, so a
  // healthMode toggle shouldn't dismiss it.)
  useEffect(() => {
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    graphRef.current?.refresh?.();
  }, [healthMode]);

  // ---------- Labels overlay (Alt held) ----------
  // Track Alt as a chord-style modifier: keydown enables labels mode,
  // keyup/blur disables. Alt+wheel cycles the visible depth band instead
  // of zooming the camera.
  useEffect(() => {
    function isTextInput(target: EventTarget | null) {
      if (!target) return false;
      const el = target as HTMLElement;
      const tag = el.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Alt') return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      // Browsers focus the menu bar on Alt-up; suppressing the default on
      // keydown also kills that side-effect when Alt is released alone.
      e.preventDefault();
      setLabelMode(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Alt') setLabelMode(false);
    }
    function reset() {
      setLabelMode(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);

  // Alt+wheel intercept on the canvas: scroll up = shallower depth, scroll
  // down = deeper. Needs a non-passive listener so preventDefault actually
  // stops OrbitControls from zooming. deltaY is accumulated so a trackpad
  // (which fires many small-delta events per swipe) bumps depth one step at
  // a time instead of racing through every level in a single gesture.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let accum = 0;
    const STEP = 50;
    function onWheel(e: WheelEvent) {
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      accum += e.deltaY;
      if (Math.abs(accum) < STEP) return;
      const dir = accum > 0 ? 1 : -1;
      accum = 0;
      setLabelLevel((lvl) => {
        const max = Math.max(1, maxDepthRef.current);
        const next = lvl + dir;
        if (next < 1) return 1;
        if (next > max) return max;
        return next;
      });
    }
    // Capture phase so we run before OrbitControls' canvas-level wheel
    // listener (which would otherwise zoom the camera before we get the
    // chance to call preventDefault).
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () =>
      container.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // Refresh sprites when labels mode toggles or the active depth changes.
  useEffect(() => {
    labelsRegistry.clear();
    graphRef.current?.refresh?.();
  }, [labelMode, labelLevel]);

  // Re-render sprites when render-only settings (sizes) change.
  useEffect(() => {
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    graphRef.current?.refresh?.();
  }, [settings.fileNodeSize, settings.dirNodeSize, settings.labelSize]);

  // Apply physics + DAG settings to the running simulation. Reheats so
  // changes visibly take effect.
  //
  // The reheat is deferred to a macrotask. Calling `d3ReheatSimulation()`
  // synchronously sets `engineRunning = true` via `resetCountdown()`. On
  // the very first run kapsule's debounced initial update hasn't fired
  // yet, so `state.layout` is still undefined — the next animation frame
  // would crash inside `layoutTick` with "Cannot read properties of
  // undefined (reading 'tick')". A short setTimeout lets kapsule's
  // ~1ms-debounced digest install `state.layout` before we reheat.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.dagLevelDistance(settings.dagLevelDistance);
    g.d3VelocityDecay(settings.velocityDecay);
    const charge = g.d3Force('charge') as
      | { strength?: (n: number) => unknown }
      | undefined;
    charge?.strength?.(settings.chargeStrength);
    const link = g.d3Force('link') as
      | { distance?: (n: number) => unknown }
      | undefined;
    link?.distance?.(settings.linkDistance);
    const timer = setTimeout(() => {
      if (graphRef.current === g) {
        g.d3ReheatSimulation();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [
    settings.dagLevelDistance,
    settings.velocityDecay,
    settings.chargeStrength,
    settings.linkDistance,
  ]);

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
  }, [contextMenu, modalAction, selected]);

  // ---------- LOC label repulsion loop ----------
  // Spread LOC labels apart so their text doesn't overlap in dense
  // clusters, with a velocity-based settle so the system stops moving
  // once an equilibrium is reached. Shared physics implementation
  // lives in labelRepulsion.ts; only the minimum desired separation
  // differs per overlay (LOC numbers are short, so 55 units is plenty).
  useEffect(() => {
    if (!locMode) return;
    let rafId = 0;
    let frameCount = 0;
    const tick = () => {
      frameCount++;
      repelLabels(locLabelRegistry, 55, frameCount);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [locMode]);

  // ---------- Health overlay repulsion loop ----------
  // Same physics as the LOC loop — health labels are also short
  // numbers, so 55 units of minimum separation is enough.
  useEffect(() => {
    if (!healthMode) return;
    let rafId = 0;
    let frameCount = 0;
    const tick = () => {
      frameCount++;
      repelLabels(healthLabelRegistry, 55, frameCount);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [healthMode]);

  // ---------- Health tooltip cursor tracking ----------
  // Track viewport-space cursor coordinates whenever the cursor is
  // over the graph container. The HealthTooltip uses position: fixed
  // (viewport coords) so we pass clientX/clientY through unchanged.
  // We track unconditionally — the tooltip itself only renders when a
  // file node is hovered AND has health data, so the listener is
  // cheap when nothing's hovered.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function onMove(ev: MouseEvent) {
      setHoverPos({ x: ev.clientX, y: ev.clientY });
    }
    function onLeave() {
      // Drop the tracked position when the cursor leaves the graph
      // viewport so a stale tooltip doesn't linger if onNodeHover
      // doesn't fire its `null` event for some reason.
      setHoverPos(null);
    }
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // ---------- Labels overlay repulsion loop ----------
  // Same physics as LOC, with a wider minimum separation because
  // file-name labels are much longer than 3-digit LOC / health values
  // and would visibly overlap at 55 units.
  useEffect(() => {
    if (!labelMode) return;
    let rafId = 0;
    let frameCount = 0;
    const tick = () => {
      frameCount++;
      repelLabels(labelsRegistry, 90, frameCount);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [labelMode]);

  // Filter via accessors — does not restart the d3 force simulation.
  // Ghost nodes are visible only when the active scrubber range marks
  // their path with a change kind ("deleted" most often, but also
  // "added" if a file was added inside the window and then later
  // removed before the user scrubbed).
  useEffect(() => {
    if (!graphRef.current) return;
    const changeMap = changeMapRef.current;
    function isNodeVisible(n: GraphNode): boolean {
      if (isGhost(n)) {
        // Only show ghost nodes whose path is in the current change map.
        return changeMap.has(n.path);
      }
      if (n.kind === 'dir') return true;
      const key = n.ext ? n.ext.toLowerCase() : '*';
      return !hiddenExts.has(key);
    }
    graphRef.current
      .nodeVisibility((n: object) => isNodeVisible(n as GraphNode))
      .linkVisibility((l: object) => {
        const link = l as {
          source: GraphNode | string;
          target: GraphNode | string;
        };
        // After graphData() is applied, source/target are hydrated to
        // node references. Before that, they're still IDs — show them
        // until hydration catches up.
        const s = typeof link.source === 'object' ? link.source : null;
        const t = typeof link.target === 'object' ? link.target : null;
        return (!s || isNodeVisible(s)) && (!t || isNodeVisible(t));
      });
  }, [hiddenExts, data, history, range]);

  // Recompute the change map when the slider range moves and refresh
  // sprites so rings update. nodeVisibility above also re-evaluates on
  // the same dep set, which hides/shows ghost nodes for the new range.
  useEffect(() => {
    if (!history) {
      changeMapRef.current = new Map();
    } else {
      changeMapRef.current = computeChangeMap(
        history.commits,
        history.uncommitted,
        range.left,
        range.right,
      );
    }
    // Sprites cached by spriteFor are reused; refresh() just re-runs
    // nodeThreeObject so the ring wrapping reflects the new map.
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    graphRef.current?.refresh?.();
  }, [history, range]);

  // ---------- Box-select drag ----------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let dragging = false;
    let activePointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let altAtStart = false;
    let prevRotate: boolean | undefined;
    let prevPan: boolean | undefined;

    // Capture phase + pointerdown so we run before OrbitControls' canvas-level
    // pointerdown listener. Without this, shift+left-click immediately
    // transitions OrbitControls into PAN state, and toggling enablePan
    // afterward has no effect for the active gesture — the camera pans
    // through the whole drag and the box-select rect tracks a moving world.
    //
    // We use pointer events for the whole gesture (down/move/up). preventDefault
    // on pointerdown suppresses the matching compat mousemove/mouseup, so a
    // mixed pointer/mouse handler set would never see the rest of the drag.
    function onPointerDown(e: PointerEvent) {
      if (!e.shiftKey || e.button !== 0) return;
      // Stop OrbitControls and 3d-force-graph's own listeners from seeing
      // this event at all.
      e.stopPropagation();
      e.stopImmediatePropagation();

      const rect = container!.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      altAtStart = e.altKey;
      dragging = true;
      activePointerId = e.pointerId;
      setDragRect({ x1: startX, y1: startY, x2: startX, y2: startY });
      setContextMenu(null);

      // Belt-and-suspenders: also disable the controls flags. If anything
      // slipped past stopPropagation, OrbitControls will bail in its
      // mouseAction switch instead of starting a pan.
      const ctrl = graphRef.current?.controls() as
        | { enableRotate?: boolean; enablePan?: boolean }
        | undefined;
      if (ctrl) {
        prevRotate = ctrl.enableRotate;
        prevPan = ctrl.enablePan;
        ctrl.enableRotate = false;
        ctrl.enablePan = false;
      }
      e.preventDefault();
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging || e.pointerId !== activePointerId) return;
      const rect = container!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDragRect({ x1: startX, y1: startY, x2: x, y2: y });
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragging || e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;

      const rect = container!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const finalRect = {
        x1: Math.min(startX, x),
        y1: Math.min(startY, y),
        x2: Math.max(startX, x),
        y2: Math.max(startY, y),
      };

      const ctrl = graphRef.current?.controls() as
        | { enableRotate?: boolean; enablePan?: boolean }
        | undefined;
      if (ctrl) {
        if (prevRotate !== undefined) ctrl.enableRotate = prevRotate;
        if (prevPan !== undefined) ctrl.enablePan = prevPan;
      }

      // Treat a tiny drag as a "click" — clear selection and bail.
      const isClick =
        finalRect.x2 - finalRect.x1 < 4 && finalRect.y2 - finalRect.y1 < 4;
      if (isClick) {
        setSelected(new Set());
        setDragRect(null);
        return;
      }

      const graph = graphRef.current;
      if (graph) {
        const camera = graph.camera() as THREE.Camera;
        const W = container!.clientWidth;
        const H = container!.clientHeight;
        const includeDirs = altAtStart;
        const next = new Set<string>();
        const v = new THREE.Vector3();
        const nodes = graph.graphData().nodes as Array<
          GraphNode & { x?: number; y?: number; z?: number }
        >;
        for (const node of nodes) {
          if (!includeDirs && node.kind === 'dir') continue;
          if (node.kind === 'file') {
            const key = node.ext ? node.ext.toLowerCase() : '*';
            if (hiddenExtsRef.current.has(key)) continue;
          }
          if (node.x == null || node.y == null || node.z == null) continue;
          v.set(node.x, node.y, node.z).project(camera);
          // Behind the camera or beyond the far plane — skip.
          if (v.z < -1 || v.z > 1) continue;
          const sx = (v.x * 0.5 + 0.5) * W;
          const sy = (-v.y * 0.5 + 0.5) * H;
          if (
            sx >= finalRect.x1 &&
            sx <= finalRect.x2 &&
            sy >= finalRect.y1 &&
            sy <= finalRect.y2
          ) {
            next.add(node.id);
          }
        }
        setSelected(next);
      }
      setDragRect(null);
    }

    container.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  // Close the context menu when clicking outside it.
  useEffect(() => {
    if (!contextMenu) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.graph-context-menu')) return;
      setContextMenu(null);
    }
    // Defer attachment so the same right-click that opened the menu doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onDown);
    };
  }, [contextMenu]);

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
  }, []);

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
