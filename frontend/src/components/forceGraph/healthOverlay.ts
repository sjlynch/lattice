// Code-health overlay (active while the user holds `h`). Each file node
// becomes a tinted shape with a vertical connector + camera-scaled text
// label showing its 0–100 health score. Labels are repulsed against
// each other in the parent component's RAF loop via healthLabelRegistry.
//
// The sprite/connector/label arrangement deliberately mirrors
// locOverlay.ts so the two views feel like siblings — same offsets,
// same texture cache pattern, same registry semantics.

import * as THREE from 'three';
import { DIR_STYLE, getStyleFor, type ExtStyle, type Shape } from '../../extensionStyles';
import type { GraphNode } from '../../api';
import { materialFor, spriteFor } from './sprites';
import type { GraphSettings } from './graphSettings';

// Health-score color thresholds. Health is 0–100 where 100 = best, so
// the polarity is inverted vs LOC: high score = green, low = red.
const HEALTH_RED = '#f57878';
const HEALTH_YELLOW = '#f5d76e';
const HEALTH_GREEN = '#7ed884';

export function healthColor(score: number): string {
  if (score < 40) return HEALTH_RED;
  if (score < 70) return HEALTH_YELLOW;
  return HEALTH_GREEN;
}

// Cache health-label textures by `text|color` so panning/zooming with
// `h` held doesn't allocate a fresh canvas every frame. Capped at 256
// entries; oldest is disposed and evicted when the cap is hit.
const MAX_HEALTH_TEXTURES = 256;
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
  if (labelTextureCache.size >= MAX_HEALTH_TEXTURES) {
    const oldest = labelTextureCache.keys().next().value!;
    labelTextureCache.get(oldest)?.dispose();
    labelTextureCache.delete(oldest);
  }
  labelTextureCache.set(key, tex);
  return tex;
}

const LABEL_ASPECT = 320 / 100;
const LABEL_REF_DIST = 200;
export const LABEL_Y = 100;

export type HealthLabelEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};
export const healthLabelRegistry = new Set<HealthLabelEntry>();

const HEALTH_LABEL_HEIGHT_MULT = 2;

function makeLabelSprite(
  text: string,
  color: string,
  baseH: number,
): THREE.Sprite {
  const tex = buildLabelTexture(text, color);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const h = baseH * HEALTH_LABEL_HEIGHT_MULT;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(h * LABEL_ASPECT, h, 1);
  sprite.renderOrder = 999;

  const _pos = new THREE.Vector3();
  sprite.onBeforeRender = (_r, _s, camera) => {
    sprite.getWorldPosition(_pos);
    const d = camera.position.distanceTo(_pos);
    const s = Math.max(6, Math.min(100, (d / LABEL_REF_DIST) * h));
    sprite.scale.set(s * LABEL_ASPECT, s, 1);
  };

  return sprite;
}

function healthShapeStyle(node: GraphNode, color: string): ExtStyle {
  const baseShape: Shape =
    node.kind === 'dir' ? DIR_STYLE.shape : getStyleFor(node.ext).shape;
  return {
    ext: `health:${baseShape}`,
    label: 'health',
    shape: baseShape,
    color1: color,
  };
}

export function spriteForHealth(
  node: GraphNode,
  settings: GraphSettings,
): THREE.Object3D {
  // Directories and files we couldn't analyze fall back to the normal
  // shape so the graph still reads as a tree.
  if (node.kind !== 'file' || node.health == null) return spriteFor(node, settings);

  const score = node.health;
  const color = healthColor(score);
  const group = new THREE.Group();

  const colorSprite = new THREE.Sprite(materialFor(healthShapeStyle(node, color)));
  colorSprite.scale.set(settings.fileNodeSize, settings.fileNodeSize, 1);
  colorSprite.renderOrder = 12;
  group.add(colorSprite);

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

  const label = makeLabelSprite(String(score), color, settings.labelSize);
  label.position.set(0, LABEL_Y, 0);
  group.add(label);

  healthLabelRegistry.add({ label, line });

  return group;
}
