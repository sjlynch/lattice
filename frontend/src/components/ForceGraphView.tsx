import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { createTask, type ScanResult, type GraphNode } from '../api';
import { Modal } from './Modal';
import {
  DIR_STYLE,
  getStyleFor,
  styleKey,
  type ExtStyle,
  type Shape,
} from '../extensionStyles';

// Lines-of-code thresholds for the "z" view. >1000 = red, >600 = yellow,
// otherwise green. Kept in sync with the legend chip wording.
const LOC_RED = '#f57878';
const LOC_YELLOW = '#f5d76e';
const LOC_GREEN = '#7ed884';

function locColor(loc: number): string {
  if (loc > 1000) return LOC_RED;
  if (loc > 600) return LOC_YELLOW;
  return LOC_GREEN;
}

type Props = {
  data: ScanResult | null;
  loading: boolean;
  hiddenExts: Set<string>;
  activeFolder: string;
};

const TEX_SIZE = 128;

// Trace a closed shape path on `ctx`, sized to fit a TEX_SIZE canvas with a
// small safety margin so antialiased edges aren't clipped.
function traceShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  const r = TEX_SIZE / 2 - 8;
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case 'square': {
      const side = r * 1.78;
      const x0 = cx - side / 2;
      const y0 = cy - side / 2;
      const rr = side * 0.16;
      ctx.moveTo(x0 + rr, y0);
      ctx.arcTo(x0 + side, y0, x0 + side, y0 + side, rr);
      ctx.arcTo(x0 + side, y0 + side, x0, y0 + side, rr);
      ctx.arcTo(x0, y0 + side, x0, y0, rr);
      ctx.arcTo(x0, y0, x0 + side, y0, rr);
      ctx.closePath();
      break;
    }
    case 'diamond':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case 'hexagon':
      // pointy-top hexagon
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    case 'triangle':
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        const x = cx + r * Math.cos(a);
        const y = cy + r * 0.95 * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
  }
}

function buildShapeTexture(style: ExtStyle): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;

  // Outline / soft glow underlay for crispness against dark backgrounds
  ctx.save();
  traceShape(ctx, style.shape);
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = style.color1;
  ctx.fill();
  ctx.restore();

  // Clip to shape, fill base color (overrides the shadow region inside)
  ctx.save();
  traceShape(ctx, style.shape);
  ctx.clip();
  ctx.fillStyle = style.color1;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Diagonal split: top-left half = color2, bottom-right half = color1.
  // Diagonal goes from top-right to bottom-left.
  if (style.color2) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(TEX_SIZE, 0);
    ctx.lineTo(0, TEX_SIZE);
    ctx.closePath();
    ctx.fillStyle = style.color2;
    ctx.fill();
  }

  // Soft inner highlight for that "lit ball" look on circles/diamonds.
  // Square/hexagon/triangle look better flat.
  if (style.shape === 'circle' || style.shape === 'diamond') {
    const grad = ctx.createRadialGradient(
      TEX_SIZE * 0.38,
      TEX_SIZE * 0.34,
      2,
      TEX_SIZE * 0.38,
      TEX_SIZE * 0.34,
      TEX_SIZE * 0.55,
    );
    grad.addColorStop(0, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  }
  ctx.restore();

  // Crisp outline so edges read against the graph
  ctx.save();
  traceShape(ctx, style.shape);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.stroke();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  // The canvas paints sRGB byte values. Without this hint three.js treats
  // them as linear, double-encodes on output, and the result is washed out
  // and brighter than the legend SVG (which goes straight to the DOM).
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const materialCache = new Map<string, THREE.SpriteMaterial>();

function materialFor(style: ExtStyle): THREE.SpriteMaterial {
  const key = styleKey(style);
  let mat = materialCache.get(key);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: buildShapeTexture(style),
      transparent: true,
      depthWrite: false,
    });
    materialCache.set(key, mat);
  }
  return mat;
}

function spriteFor(node: GraphNode): THREE.Sprite {
  const style =
    node.kind === 'dir' ? DIR_STYLE : getStyleFor(node.ext);
  const sprite = new THREE.Sprite(materialFor(style));
  const size = node.kind === 'dir' ? 7 : 5.5;
  sprite.scale.set(size, size, 1);
  return sprite;
}

// Cache LOC text-label textures by `text|color` so panning/zooming with
// `z` held doesn't allocate a fresh canvas every frame.
const labelTextureCache = new Map<string, THREE.CanvasTexture>();

function buildLabelTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;
  const W = 320;
  const H = 100;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, W / 2, H / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  labelTextureCache.set(key, tex);
  return tex;
}

// Canvas aspect ratio for label textures (W:H = 320:100 = 3.2).
const LABEL_ASPECT = 320 / 100;
// Base world-space height at the reference camera distance.
const LABEL_BASE_H = 8;
const LABEL_REF_DIST = 200;
// World-space Y offset of the label sprite above its file node. Pushed up
// well clear of the node so dense clusters don't overlap their labels.
const LABEL_Y = 70;
// Local-space registry of active LOC label sprites. The relaxation loop in
// ForceGraphView walks this each frame to apply pairwise repulsion and to
// keep each connector line's upper endpoint anchored to its label.
type LocLabelEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};
const locLabelRegistry = new Set<LocLabelEntry>();

function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const tex = buildLabelTexture(text, color);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(LABEL_BASE_H * LABEL_ASPECT, LABEL_BASE_H, 1);
  // Render label on top so it's never occluded by a sibling sprite.
  sprite.renderOrder = 999;

  // Scale the label proportionally to camera distance so it stays readable
  // at any zoom level — closer camera → smaller sprite, farther → larger.
  const _pos = new THREE.Vector3();
  sprite.onBeforeRender = (_r, _s, camera) => {
    sprite.getWorldPosition(_pos);
    const d = camera.position.distanceTo(_pos);
    const s = Math.max(3, Math.min(50, (d / LABEL_REF_DIST) * LABEL_BASE_H));
    sprite.scale.set(s * LABEL_ASPECT, s, 1);
  };

  return sprite;
}

function locShapeStyle(node: GraphNode, color: string): ExtStyle {
  const baseShape: Shape =
    node.kind === 'dir' ? DIR_STYLE.shape : getStyleFor(node.ext).shape;
  return {
    ext: `loc:${baseShape}`,
    label: 'loc',
    shape: baseShape,
    color1: color,
  };
}

function spriteForLoc(node: GraphNode): THREE.Object3D {
  // Directories and files we couldn't measure fall back to the normal
  // shape so the graph still reads as a tree.
  if (node.kind !== 'file' || node.loc == null) return spriteFor(node);

  const color = locColor(node.loc);
  const group = new THREE.Group();

  const colorSprite = new THREE.Sprite(materialFor(locShapeStyle(node, color)));
  colorSprite.scale.set(5.5, 5.5, 1);
  group.add(colorSprite);

  // Connector starts just above the node sprite and runs up to the label.
  // The upper endpoint is kept in sync with the label position by the
  // relaxation loop in ForceGraphView (see locLabelRegistry).
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 3, 0),
    new THREE.Vector3(0, LABEL_Y - 4, 0),
  ]);
  const lineMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.9,
  });
  const line = new THREE.Line(lineGeom, lineMat);
  group.add(line);

  const label = makeLabelSprite(String(node.loc), color);
  label.position.set(0, LABEL_Y, 0);
  group.add(label);

  locLabelRegistry.add({ label, line });

  return group;
}

// ---------- Selection halo ----------

let _haloTexture: THREE.CanvasTexture | null = null;
function haloTexture(): THREE.CanvasTexture {
  if (_haloTexture) return _haloTexture;
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(
    SIZE / 2, SIZE / 2, SIZE * 0.18,
    SIZE / 2, SIZE / 2, SIZE * 0.50,
  );
  grad.addColorStop(0, 'rgba(120, 200, 255, 0.85)');
  grad.addColorStop(0.55, 'rgba(120, 200, 255, 0.30)');
  grad.addColorStop(1, 'rgba(120, 200, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _haloTexture = tex;
  return tex;
}

let _haloMaterial: THREE.SpriteMaterial | null = null;
function haloMaterial(): THREE.SpriteMaterial {
  if (_haloMaterial) return _haloMaterial;
  _haloMaterial = new THREE.SpriteMaterial({
    map: haloTexture(),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  return _haloMaterial;
}

function withHalo(child: THREE.Object3D, baseSize: number): THREE.Object3D {
  const group = new THREE.Group();
  const halo = new THREE.Sprite(haloMaterial());
  const s = baseSize * 1.9;
  halo.scale.set(s, s, 1);
  halo.renderOrder = -1;
  group.add(halo);
  group.add(child);
  return group;
}

// ---------- Path helpers ----------

function relPath(full: string, root: string): string {
  if (!root) return full.replace(/\\/g, '/');
  const r = root.replace(/[\\/]+$/, '');
  if (full.startsWith(r)) {
    return full.slice(r.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  return full.replace(/\\/g, '/');
}

// ---------- Context-menu items ----------

type MenuItemDef = {
  verb: string;
  label: string;
  prefill: string;
};

const MENU_ITEMS: MenuItemDef[] = [
  {
    verb: 'Refactor',
    label: 'Refactor selection…',
    prefill: 'Refactor the following files. <user instruction>',
  },
  {
    verb: 'Add tests',
    label: 'Add tests for selection…',
    prefill:
      "Write or expand tests for the following files using the project's existing test conventions.",
  },
  {
    verb: 'Document',
    label: 'Document selection…',
    prefill:
      'Add or improve docstrings/inline comments for these files. Keep comments minimal and only where the WHY is non-obvious.',
  },
  {
    verb: 'Find dead code',
    label: 'Find dead code…',
    prefill:
      'Identify and report any unused exports/functions/variables in these files.',
  },
];

type DragRect = { x1: number; y1: number; x2: number; y2: number };

export function ForceGraphView({ data, loading, hiddenExts, activeFolder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  // Lines-of-code overlay: active while the user holds `z`. Tracked in
  // both state (for the chip overlay) and a ref (so the nodeThreeObject
  // accessor — wired into the graph once at mount — reads the live value).
  const [locMode, setLocMode] = useState(false);
  const locModeRef = useRef(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRef<Set<string>>(new Set());
  const hiddenExtsRef = useRef<Set<string>>(hiddenExts);

  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [modalAction, setModalAction] = useState<MenuItemDef | null>(null);
  const [promptText, setPromptText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    locModeRef.current = locMode;
  }, [locMode]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    hiddenExtsRef.current = hiddenExts;
  }, [hiddenExts]);

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
        const obj = locModeRef.current ? spriteForLoc(node) : spriteFor(node);
        if (selectedRef.current.has(node.id)) {
          const baseSize = node.kind === 'dir' ? 7 : 5.5;
          return withHalo(obj, baseSize);
        }
        return obj;
      })
      .nodeRelSize(1)
      .linkColor(() => 'rgba(220,228,240,0.55)')
      .linkOpacity(0.85)
      .linkWidth(0.7)
      .dagMode('td')
      .dagLevelDistance(50)
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
    // A new scan invalidates the previous selection (node IDs may differ).
    setSelected(new Set());
  }, [data]);

  // Toggle LOC view on/off when the `z` key is held. Keyup also fires on
  // window blur (Alt-Tab, dev-tools focus) — we can't trust `keyup`
  // alone, so reset on blur and on visibility loss as well.
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

  // Pairwise repulsion between LOC labels in their parent file nodes' local
  // X/Z plane. Lets labels in dense clusters spread apart so their text
  // doesn't overlap, while a gentle pull-back keeps them anchored above
  // their owning node. Active only while LOC mode is on.
  useEffect(() => {
    if (!locMode) return;
    const tmp = new THREE.Vector3();
    const MIN_DIST = 22; // world units; below this, labels push apart
    const PUSH = 0.08;
    const DAMP = 0.93; // 7% pull toward each label's home offset per frame
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
    </div>
  );
}
