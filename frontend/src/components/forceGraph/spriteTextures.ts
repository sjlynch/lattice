// Canvas → CanvasTexture rendering for the per-extension graph sprites.
// `buildShapeTexture` paints a shape in three ordered phases:
//   1. a soft drop-shadow underlay so the sprite reads against dark space,
//   2. a clipped flat base fill (+ optional diagonal two-tone split),
//   3. a crisp dark outline so edges stay legible against the graph.
// The fill is deliberately *flat* — no inner highlight gradient — so file
// nodes read as flat discs/shapes rather than lit spheres, which makes the
// task/change/worktree rings around them far easier to tell apart. The fill
// colors are also darkened from the legend's source colors (see DARKEN) so
// the brighter rings pop against them.
// The shape geometry itself comes from `spriteShapes.ts`; this module owns
// the rendering constants (shadow, fill darkening, outline, opacity).

import * as THREE from 'three';
import type { ExtStyle } from '../../extensionStyles';
import { TEX_SIZE, traceShape } from './spriteShapes';

// Phase 1 — soft drop-shadow underlay.
const SHADOW_COLOR = 'rgba(0,0,0,0.55)';
const SHADOW_BLUR = 6;

// Phase 3 — crisp outline.
const OUTLINE_WIDTH = 1.5;
const OUTLINE_COLOR = 'rgba(0,0,0,0.45)';

// Fill darkening. Every per-extension fill is multiplied down from its
// legend color so the node bodies sit darker than the rings/labels drawn on
// top of them. The Legend (DOM SVG) keeps the original, brighter color as
// the canonical swatch.
const DARKEN = 0.7;

// Texture sampling quality.
const TEX_ANISOTROPY = 4;

// Darken a `#rgb` / `#rrggbb` hex color toward black by `f` (0..1) and return
// an `rgb(r,g,b)` string. Parsed manually (rather than via THREE.Color) to
// avoid sRGB↔linear conversions shifting the hue.
function darkenHex(hex: string, f: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  const r = Math.round(((n >> 16) & 0xff) * f);
  const g = Math.round(((n >> 8) & 0xff) * f);
  const b = Math.round((n & 0xff) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

export function buildShapeTexture(style: ExtStyle): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;

  const fill1 = darkenHex(style.color1, DARKEN);
  const fill2 = style.color2 ? darkenHex(style.color2, DARKEN) : null;

  // Outline / soft glow underlay for crispness against dark backgrounds
  ctx.save();
  traceShape(ctx, style.shape);
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = SHADOW_BLUR;
  ctx.fillStyle = fill1;
  ctx.fill();
  ctx.restore();

  // Clip to shape, fill flat base color (overrides the shadow region inside).
  // No inner highlight gradient — file nodes read as flat shapes, not lit
  // spheres, so the rings around them stay legible.
  ctx.save();
  traceShape(ctx, style.shape);
  ctx.clip();
  ctx.fillStyle = fill1;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Diagonal split: top-left half = color2, bottom-right half = color1.
  // Diagonal goes from top-right to bottom-left.
  if (fill2) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(TEX_SIZE, 0);
    ctx.lineTo(0, TEX_SIZE);
    ctx.closePath();
    ctx.fillStyle = fill2;
    ctx.fill();
  }
  ctx.restore();

  // Crisp outline so edges read against the graph
  ctx.save();
  traceShape(ctx, style.shape);
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.stroke();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = TEX_ANISOTROPY;
  // The canvas paints sRGB byte values. Without this hint three.js treats
  // them as linear, double-encodes on output, and the result is washed out
  // and brighter than the legend SVG (which goes straight to the DOM).
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
