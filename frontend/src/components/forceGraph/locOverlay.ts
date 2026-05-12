// Lines-of-code overlay (active while the user holds `z`). Each file node
// becomes a tinted shape with a vertical connector + camera-scaled text
// label showing its LOC count. Labels are repulsed against each other in
// the parent component's RAF loop via locLabelRegistry.

import * as THREE from 'three';
import { DIR_STYLE, getStyleFor, type ExtStyle, type Shape } from '../../extensionStyles';
import type { GraphNode } from '../../api';
import { materialFor, spriteFor } from './sprites';
import type { GraphSettings } from './graphSettings';
import {
  disableRaycast,
  restrictSpriteRaycast,
  type SpriteUvBounds,
} from './spritePicking';

// Lines-of-code thresholds for the "z" view. >1000 = red, >600 = yellow,
// otherwise green. Kept in sync with the legend chip wording.
const LOC_RED = '#f57878';
const LOC_YELLOW = '#f5d76e';
const LOC_GREEN = '#7ed884';

export function locColor(loc: number): string {
  if (loc > 1000) return LOC_RED;
  if (loc > 600) return LOC_YELLOW;
  return LOC_GREEN;
}

// Cache LOC text-label textures by `text|color` so panning/zooming with
// `z` held doesn't allocate a fresh canvas every frame. Capped at 256
// entries; the oldest entry is disposed and evicted when the cap is hit.
const MAX_LOC_TEXTURES = 256;
const LABEL_FONT = 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
const LABEL_STROKE_WIDTH = 10;
const LABEL_H = 96;
const LABEL_PAD_X = 18;
const MIN_NUMERIC_LABEL_W = 80;

type LocLabelTexture = THREE.CanvasTexture & {
  _aspect?: number;
  _hitBounds?: SpriteUvBounds;
};

const labelTextureCache = new Map<string, LocLabelTexture>();

function measuredTextWidth(metrics: TextMetrics): number {
  const actual = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
  return Math.ceil(actual > 0 ? actual : metrics.width);
}

function buildLabelTexture(text: string, color: string): LocLabelTexture {
  const key = `${text}|${color}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = LABEL_FONT;
  const measured = measuredTextWidth(probe.measureText(text));
  const visualW = measured + LABEL_STROKE_WIDTH + 2;
  const W = Math.max(MIN_NUMERIC_LABEL_W, visualW + LABEL_PAD_X * 2);
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
  const tex = new THREE.CanvasTexture(canvas) as LocLabelTexture;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex._aspect = W / LABEL_H;
  const hitW = Math.min(W, visualW + LABEL_PAD_X);
  tex._hitBounds = {
    minU: Math.max(0, (W - hitW) / 2 / W),
    maxU: Math.min(1, 1 - (W - hitW) / 2 / W),
    minV: 0.12,
    maxV: 0.88,
  };
  if (labelTextureCache.size >= MAX_LOC_TEXTURES) {
    const oldest = labelTextureCache.keys().next().value!;
    labelTextureCache.get(oldest)?.dispose();
    labelTextureCache.delete(oldest);
  }
  labelTextureCache.set(key, tex);
  return tex;
}
// Reference camera distance for the LOC label scale curve. Closer →
// smaller, farther → larger; a `baseH` parameter tunes the absolute size.
const LABEL_REF_DIST = 200;
// World-space Y offset of the label sprite above its file node. Pushed up
// well clear of the node so dense clusters don't overlap their labels.
export const LABEL_Y = 100;

// Local-space registry of active LOC label sprites. The relaxation loop
// in ForceGraphView walks this each frame to apply pairwise repulsion and
// to keep each connector line's upper endpoint anchored to its label.
export type LocLabelEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};
export const locLabelRegistry = new Set<LocLabelEntry>();

// Multiplier on top of the user's `labelSize` setting for LOC labels —
// makes them roughly twice as tall as a regular sprite of the same baseH.
const LOC_LABEL_HEIGHT_MULT = 2;

function makeLabelSprite(
  text: string,
  color: string,
  baseH: number,
): THREE.Sprite {
  const tex = buildLabelTexture(text, color);
  const aspect = tex._aspect ?? 1;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const h = baseH * LOC_LABEL_HEIGHT_MULT;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(h * aspect, h, 1);
  restrictSpriteRaycast(sprite, tex._hitBounds ?? {
    minU: 0,
    maxU: 1,
    minV: 0,
    maxV: 1,
  });
  // Render label on top so it's never occluded by a sibling sprite.
  sprite.renderOrder = 999;

  // Scale the label proportionally to camera distance so it stays readable
  // at any zoom level — closer camera → smaller sprite, farther → larger.
  const _pos = new THREE.Vector3();
  sprite.onBeforeRender = (_r, _s, camera) => {
    sprite.getWorldPosition(_pos);
    const d = camera.position.distanceTo(_pos);
    const s = Math.max(6, Math.min(100, (d / LABEL_REF_DIST) * h));
    sprite.scale.set(s * aspect, s, 1);
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

export function spriteForLoc(
  node: GraphNode,
  settings: GraphSettings,
): THREE.Object3D {
  // Directories and files we couldn't measure fall back to the normal
  // shape so the graph still reads as a tree.
  if (node.kind !== 'file' || node.loc == null) return spriteFor(node, settings);

  const color = locColor(node.loc);
  const group = new THREE.Group();

  const colorSprite = new THREE.Sprite(materialFor(locShapeStyle(node, color)));
  colorSprite.scale.set(settings.fileNodeSize, settings.fileNodeSize, 1);
  // Match the regular spriteFor renderOrder so the LOC-tinted shape also
  // paints on top of the connection lines (library sets links to renderOrder=10).
  colorSprite.renderOrder = 12;
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
  disableRaycast(line);
  group.add(line);

  const label = makeLabelSprite(String(node.loc), color, settings.labelSize);
  label.position.set(0, LABEL_Y, 0);
  group.add(label);

  locLabelRegistry.add({ label, line });

  return group;
}
