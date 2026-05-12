// Labels overlay (active while the user holds Alt). Each node at the
// currently-active depth gets a name label floating above it; alt+wheel
// scrolls through depth levels so the user can read the graph one band of
// names at a time without overwhelming clutter.

import * as THREE from 'three';
import type { GraphNode } from '../../api';
import { spriteFor } from './sprites';
import type { GraphSettings } from './graphSettings';
import {
  disableRaycast,
  restrictSpriteRaycast,
  type SpriteUvBounds,
} from './spritePicking';

// Node depth derived from path: root has depth 0; every path separator past
// the root prefix bumps the depth by one. Works for both POSIX and Windows
// separators since we count both.
export function depthFor(node: GraphNode, root: string): number {
  if (!root || !node.path.startsWith(root)) return 0;
  const rest = node.path.slice(root.length);
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest.charCodeAt(i);
    if (ch === 47 /* / */ || ch === 92 /* \ */) n++;
  }
  return n;
}

// Capped at 256 entries; the oldest entry is disposed and evicted when the
// cap is hit to prevent unbounded GPU memory growth on large repos.
const MAX_LABEL_TEXTURES = 256;
const LABEL_FONT = 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
const LABEL_STROKE_WIDTH = 10;
const LABEL_H = 96;
const LABEL_PAD_X = 20;
const MIN_NAME_LABEL_W = 96;

type NameLabelTexture = THREE.CanvasTexture & {
  _aspect?: number;
  _hitBounds?: SpriteUvBounds;
};

const labelTextureCache = new Map<string, NameLabelTexture>();

function measuredTextWidth(metrics: TextMetrics): number {
  const actual = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
  return Math.ceil(actual > 0 ? actual : metrics.width);
}

function buildNameTexture(text: string, color: string): NameLabelTexture {
  const key = `${text}|${color}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;
  // Measure once with a throwaway context to size the canvas to the text.
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = LABEL_FONT;
  const measured = measuredTextWidth(probe.measureText(text));
  const visualW = measured + LABEL_STROKE_WIDTH + 2;
  const W = Math.max(MIN_NAME_LABEL_W, visualW + LABEL_PAD_X * 2);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = LABEL_H;
  const ctx = canvas.getContext('2d')!;
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LABEL_STROKE_WIDTH;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, W / 2, LABEL_H / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, LABEL_H / 2);
  const tex = new THREE.CanvasTexture(canvas) as NameLabelTexture;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  // Stash aspect / hit bounds on the texture so the sprite can read them
  // without re-measuring.
  tex._aspect = W / LABEL_H;
  const hitW = Math.min(W, visualW + LABEL_PAD_X);
  tex._hitBounds = {
    minU: Math.max(0, (W - hitW) / 2 / W),
    maxU: Math.min(1, 1 - (W - hitW) / 2 / W),
    minV: 0.12,
    maxV: 0.88,
  };
  if (labelTextureCache.size >= MAX_LABEL_TEXTURES) {
    const oldest = labelTextureCache.keys().next().value!;
    labelTextureCache.get(oldest)?.dispose();
    labelTextureCache.delete(oldest);
  }
  labelTextureCache.set(key, tex);
  return tex;
}

const LABEL_REF_DIST = 200;
// Pushed up well clear of the node — same offset as the LOC overlay — so
// dense clusters of labels can fan out without crashing into their nodes.
export const LABEL_Y = 100;

// Local-space registry of active name-label sprites + their connector
// lines. The relaxation loop in ForceGraphView walks this each frame to
// spread overlapping labels apart and to keep the connector's upper
// endpoint anchored to its label, mirroring the LOC overlay.
export type LabelEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};
export const labelsRegistry = new Set<LabelEntry>();

function makeNameSprite(text: string, color: string, baseH: number): THREE.Sprite {
  const tex = buildNameTexture(text, color);
  const aspect = tex._aspect ?? 3;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const h = baseH * 1.6;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(h * aspect, h, 1);
  restrictSpriteRaycast(sprite, tex._hitBounds ?? {
    minU: 0,
    maxU: 1,
    minV: 0,
    maxV: 1,
  });
  sprite.renderOrder = 999;

  const _pos = new THREE.Vector3();
  sprite.onBeforeRender = (_r, _s, camera) => {
    sprite.getWorldPosition(_pos);
    const d = camera.position.distanceTo(_pos);
    const s = Math.max(6, Math.min(120, (d / LABEL_REF_DIST) * h));
    sprite.scale.set(s * aspect, s, 1);
  };

  return sprite;
}

// Build a node object for labels mode. If the node sits at the active
// depth, attach a floating name label + connector; otherwise just render
// the normal sprite.
export function spriteForLabels(
  node: GraphNode,
  settings: GraphSettings,
  activeDepth: number,
  nodeDepth: number,
): THREE.Object3D {
  const base = spriteFor(node, settings);
  if (nodeDepth !== activeDepth) return base;

  const group = new THREE.Group();
  group.add(base);

  const color = node.kind === 'dir' ? '#e6c07b' : '#dce4f0';
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 3, 0),
    new THREE.Vector3(0, LABEL_Y - 4, 0),
  ]);
  const lineMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.7,
  });
  const line = new THREE.Line(lineGeom, lineMat);
  disableRaycast(line);
  group.add(line);

  const label = makeNameSprite(node.name, color, settings.labelSize);
  label.position.set(0, LABEL_Y, 0);
  group.add(label);

  labelsRegistry.add({ label, line });

  return group;
}
