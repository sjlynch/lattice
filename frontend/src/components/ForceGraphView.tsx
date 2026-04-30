import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult, GraphNode } from '../api';
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
  const W = 256;
  const H = 80;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 44px -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
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

function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const tex = buildLabelTexture(text, color);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  // Canvas aspect 256:80 = 3.2; pick a world-space size that reads from
  // typical orbit distances without being so large it overlaps neighbors.
  sprite.scale.set(13, 4.0625, 1);
  // Render label on top so it's never occluded by a sibling sprite.
  sprite.renderOrder = 999;
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
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 3, 0),
    new THREE.Vector3(0, 14, 0),
  ]);
  const lineMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.9,
  });
  const line = new THREE.Line(lineGeom, lineMat);
  group.add(line);

  const label = makeLabelSprite(String(node.loc), color);
  label.position.set(0, 17, 0);
  group.add(label);

  return group;
}

export function ForceGraphView({ data, loading, hiddenExts }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  // Lines-of-code overlay: active while the user holds `z`. Tracked in
  // both state (for the chip overlay) and a ref (so the nodeThreeObject
  // accessor — wired into the graph once at mount — reads the live value).
  const [locMode, setLocMode] = useState(false);
  const locModeRef = useRef(false);

  useEffect(() => {
    locModeRef.current = locMode;
  }, [locMode]);

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
        return locModeRef.current ? spriteForLoc(node) : spriteFor(node);
      })
      .nodeRelSize(1)
      .linkColor(() => 'rgba(220,228,240,0.55)')
      .linkOpacity(0.85)
      .linkWidth(0.7)
      .dagMode('td')
      .dagLevelDistance(50)
      .showNavInfo(false);

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

    return () => {
      ro.disconnect();
      graph._destructor?.();
      graphRef.current = null;
    };
  }, []);

  // Push the full dataset only when the scan changes. Filtering by
  // extension goes through nodeVisibility/linkVisibility below, which
  // keeps the simulation positions stable.
  useEffect(() => {
    if (!graphRef.current) return;
    if (!data) {
      graphRef.current.graphData({ nodes: [], links: [] });
      return;
    }
    graphRef.current.graphData({
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    });
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

  // Re-render node THREE objects when the LOC overlay toggles. refresh()
  // re-evaluates nodeThreeObject without restarting the d3 simulation, so
  // node positions stay put.
  useEffect(() => {
    graphRef.current?.refresh?.();
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
    </div>
  );
}
