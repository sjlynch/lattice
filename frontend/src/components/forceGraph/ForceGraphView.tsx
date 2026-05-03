import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { Settings as SettingsIcon } from 'lucide-react';
import { createTask, type ScanResult, type GraphNode } from '../../api';
import { Modal } from '../Modal';
import { spriteFor } from './sprites';
import { withHalo } from './halo';
import { locLabelRegistry, spriteForLoc } from './locOverlay';
import { depthFor, spriteForLabels } from './labelsOverlay';
import { MENU_ITEMS, relPath, type MenuItemDef } from './menu';
import { loadSettings, type GraphSettings } from './graphSettings';
import { GraphSettingsPanel } from './GraphSettingsPanel';

type Props = {
  data: ScanResult | null;
  loading: boolean;
  hiddenExts: Set<string>;
  activeFolder: string;
};

type DragRect = { x1: number; y1: number; x2: number; y2: number };

// Hosts the 3d-force-graph instance, the LOC overlay (`z` keypress), the
// shift-drag box-select, the right-click "create task" menu, and the
// settings panel. Each of those concerns is split into a useEffect below.
export function ForceGraphView({ data, loading, hiddenExts, activeFolder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);

  // Lines-of-code overlay: active while the user holds `z`. Tracked in
  // both state (for the chip overlay) and a ref (so the nodeThreeObject
  // accessor — wired into the graph once at mount — reads the live value).
  const [locMode, setLocMode] = useState(false);
  const locModeRef = useRef(false);

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

  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [modalAction, setModalAction] = useState<MenuItemDef | null>(null);
  const [promptText, setPromptText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { locModeRef.current = locMode; }, [locMode]);
  useEffect(() => { labelModeRef.current = labelMode; }, [labelMode]);
  useEffect(() => { labelLevelRef.current = labelLevel; }, [labelLevel]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { hiddenExtsRef.current = hiddenExts; }, [hiddenExts]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Reload persisted settings when the active project changes.
  useEffect(() => {
    setSettings(loadSettings(activeFolder));
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
        return node.kind === 'dir' ? `📁 ${node.name}` : node.name;
      })
      .nodeThreeObject((n: object) => {
        const node = n as GraphNode;
        const s = settingsRef.current;
        let obj: THREE.Object3D;
        if (locModeRef.current) {
          obj = spriteForLoc(node, s);
        } else if (labelModeRef.current) {
          const d = nodeDepthsRef.current.get(node.id) ?? 0;
          obj = spriteForLabels(node, s, labelLevelRef.current, d);
        } else {
          obj = spriteFor(node, s);
        }
        if (selectedRef.current.has(node.id)) {
          const baseSize = node.kind === 'dir' ? s.dirNodeSize : s.fileNodeSize;
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
      .onNodeRightClick((n: object, ev: MouseEvent) => {
        const node = n as GraphNode;
        if (!selectedRef.current.has(node.id)) return;
        ev.preventDefault();
        setContextMenu({ x: ev.clientX, y: ev.clientY });
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
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    // Suppress the browser's native context menu over the graph so our
    // popover can show on right-click of selected nodes without it.
    const onCtxMenu = (e: MouseEvent) => e.preventDefault();
    containerRef.current.addEventListener('contextmenu', onCtxMenu);

    return () => {
      ro.disconnect();
      containerRef.current?.removeEventListener('contextmenu', onCtxMenu);
      graph._destructor?.();
      graphRef.current = null;
    };
  }, []);

  // Push the full dataset only when the scan changes. Filtering by
  // extension goes through nodeVisibility/linkVisibility below, which
  // keeps the simulation positions stable.
  useEffect(() => {
    if (!graphRef.current) return;
    // Stale labels reference Sprites that get replaced on data swap.
    locLabelRegistry.clear();
    if (!data) {
      graphRef.current.graphData({ nodes: [], links: [] });
      return;
    }
    graphRef.current.graphData({
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
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
  }, [data]);

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
    graphRef.current?.refresh?.();
  }, [locMode, selected]);

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
    graphRef.current?.refresh?.();
  }, [labelMode, labelLevel]);

  // Re-render sprites when render-only settings (sizes) change.
  useEffect(() => {
    locLabelRegistry.clear();
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
  // Pairwise repulsion between LOC labels in their parent file nodes' local
  // X/Z plane. Lets labels in dense clusters spread apart so their text
  // doesn't overlap, while a gentle pull-back keeps them anchored above
  // their owning node. Active only while LOC mode is on.
  useEffect(() => {
    if (!locMode) return;
    const tmp = new THREE.Vector3();
    const MIN_DIST = 55; // world units; below this, labels push apart
    const PUSH = 0.1;
    const DAMP = 0.97; // 3% pull toward each label's home offset per frame
    let rafId = 0;
    const tick = () => {
      // Drop entries whose label was detached from the scene graph.
      for (const e of locLabelRegistry) {
        if (!e.label.parent) locLabelRegistry.delete(e);
      }
      const entries = Array.from(locLabelRegistry);
      const worldXZ: { x: number; z: number }[] = entries.map((e) => {
        e.label.getWorldPosition(tmp);
        return { x: tmp.x, z: tmp.z };
      });
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = worldXZ[i];
          const b = worldXZ[j];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < MIN_DIST * MIN_DIST && d2 > 1e-4) {
            const d = Math.sqrt(d2);
            const push = (MIN_DIST - d) * PUSH;
            const nx = dx / d;
            const nz = dz / d;
            entries[i].label.position.x -= nx * push;
            entries[i].label.position.z -= nz * push;
            entries[j].label.position.x += nx * push;
            entries[j].label.position.z += nz * push;
            worldXZ[i].x -= nx * push;
            worldXZ[i].z -= nz * push;
            worldXZ[j].x += nx * push;
            worldXZ[j].z += nz * push;
          }
        }
      }
      for (const e of entries) {
        // Pull each label gently back toward its home (directly above its
        // file node) so they don't drift far in sparse regions.
        e.label.position.x *= DAMP;
        e.label.position.z *= DAMP;
        // Anchor the connector line's upper endpoint to the label's lower
        // edge — accounting for the camera-adaptive height set in
        // makeLabelSprite's onBeforeRender — so the line always reaches it.
        const halfH = e.label.scale.y / 2;
        const attr = (e.line.geometry as THREE.BufferGeometry).getAttribute(
          'position',
        ) as THREE.BufferAttribute;
        attr.setXYZ(
          1,
          e.label.position.x,
          e.label.position.y - halfH,
          e.label.position.z,
        );
        attr.needsUpdate = true;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [locMode]);

  // Filter via accessors — does not restart the d3 force simulation.
  useEffect(() => {
    if (!graphRef.current) return;
    function isNodeVisible(n: GraphNode): boolean {
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
  }, [hiddenExts]);

  // ---------- Box-select drag ----------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let altAtStart = false;
    let prevRotate: boolean | undefined;
    let prevPan: boolean | undefined;

    function onMouseDown(e: MouseEvent) {
      if (!e.shiftKey || e.button !== 0) return;
      const rect = container!.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      altAtStart = e.altKey;
      dragging = true;
      setDragRect({ x1: startX, y1: startY, x2: startX, y2: startY });
      setContextMenu(null);

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

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      const rect = container!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDragRect({ x1: startX, y1: startY, x2: x, y2: y });
    }

    function onMouseUp(e: MouseEvent) {
      if (!dragging) return;
      dragging = false;

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

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
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

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {loading && (
        <div className="graph-overlay top-left">
          <span className="spinner" />
          <span>Scanning…</span>
        </div>
      )}
      {locMode && (
        <div className="loc-view-chip">View: Lines of Code</div>
      )}
      {labelMode && !locMode && (
        <div className="loc-view-chip">
          View: Labels · depth {labelLevel}
          {maxDepthRef.current > 0 && ` / ${maxDepthRef.current}`}
          <span style={{ opacity: 0.7, marginLeft: 8 }}>
            (alt+wheel to scroll)
          </span>
        </div>
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
