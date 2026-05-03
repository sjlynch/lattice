// Per-extension shape sprites for the 3D graph. Each sprite is a
// CanvasTexture rendered to a 128px square; we cache the SpriteMaterial
// per (extension, shape, color) tuple so the simulation only allocates
// once per kind regardless of how many nodes share that style.

import * as THREE from 'three';
import {
  DIR_STYLE,
  getStyleFor,
  styleKey,
  type ExtStyle,
  type Shape,
} from '../../extensionStyles';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';

export const TEX_SIZE = 128;

// Trace a closed shape path on `ctx`, sized to fit a TEX_SIZE canvas with
// a small safety margin so antialiased edges aren't clipped.
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

export function buildShapeTexture(style: ExtStyle): THREE.Texture {
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

export function materialFor(style: ExtStyle): THREE.SpriteMaterial {
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

export function spriteFor(node: GraphNode, settings: GraphSettings): THREE.Sprite {
  const style = node.kind === 'dir' ? DIR_STYLE : getStyleFor(node.ext);
  const sprite = new THREE.Sprite(materialFor(style));
  const size =
    node.kind === 'dir' ? settings.dirNodeSize : settings.fileNodeSize;
  sprite.scale.set(size, size, 1);
  return sprite;
}
