import * as THREE from 'three';
import type { SpriteUvBounds } from './spritePicking';

export type MeasuredLabelTexture = THREE.CanvasTexture & {
  _aspect?: number;
  _hitBounds?: SpriteUvBounds;
};

export type LabelTextureCache = Map<string, MeasuredLabelTexture>;

export type LabelTextureOptions = {
  font: string;
  strokeWidth: number;
  height: number;
  padX: number;
  minWidth: number;
  maxEntries: number;
  strokeStyle?: string;
  minV?: number;
  maxV?: number;
};

export function createLabelTextureCache(): LabelTextureCache {
  return new Map<string, MeasuredLabelTexture>();
}

function measuredTextWidth(metrics: TextMetrics): number {
  const actual = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
  return Math.ceil(actual > 0 ? actual : metrics.width);
}

export function buildMeasuredLabelTexture(
  cache: LabelTextureCache,
  text: string,
  color: string,
  options: LabelTextureOptions,
): MeasuredLabelTexture {
  const key = `${text}|${color}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = options.font;
  const measured = measuredTextWidth(probe.measureText(text));
  const visualW = measured + options.strokeWidth + 2;
  const W = Math.max(options.minWidth, visualW + options.padX * 2);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = options.height;

  const ctx = canvas.getContext('2d')!;
  ctx.font = options.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = options.strokeWidth;
  ctx.strokeStyle = options.strokeStyle ?? 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, W / 2, options.height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, options.height / 2);

  const tex = new THREE.CanvasTexture(canvas) as MeasuredLabelTexture;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex._aspect = W / options.height;

  const hitW = Math.min(W, visualW + options.padX);
  tex._hitBounds = {
    minU: Math.max(0, (W - hitW) / 2 / W),
    maxU: Math.min(1, 1 - (W - hitW) / 2 / W),
    minV: options.minV ?? 0.12,
    maxV: options.maxV ?? 0.88,
  };

  if (cache.size >= options.maxEntries) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)?.dispose();
    cache.delete(oldest);
  }
  cache.set(key, tex);
  return tex;
}
