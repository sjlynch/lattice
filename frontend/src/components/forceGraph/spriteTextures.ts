// Canvas → CanvasTexture rendering for the per-extension graph sprites.
// `buildShapeTexture` paints a shape in four ordered phases:
//   1. a soft drop-shadow underlay so the sprite reads against dark space,
//   2. a clipped base fill (+ optional diagonal two-tone split),
//   3. a soft inner highlight (circles/diamonds only) for a "lit ball" look,
//   4. a crisp dark outline so edges stay legible against the graph.
// The shape geometry itself comes from `spriteShapes.ts`; this module owns
// the rendering constants (shadow, highlight gradient, outline, opacity).

import * as THREE from 'three';
import type { ExtStyle } from '../../extensionStyles';
import { TEX_SIZE, traceShape } from './spriteShapes';

// Phase 1 — soft drop-shadow underlay.
const SHADOW_COLOR = 'rgba(0,0,0,0.55)';
const SHADOW_BLUR = 6;

// Phase 3 — inner highlight gradient. The light source sits up-and-left of
// center (HIGHLIGHT_X/Y as fractions of TEX_SIZE) and fades from a faint
// white core out to a radius of HIGHLIGHT_RADIUS * TEX_SIZE.
const HIGHLIGHT_X = 0.38;
const HIGHLIGHT_Y = 0.34;
const HIGHLIGHT_INNER_RADIUS = 2;
const HIGHLIGHT_RADIUS = 0.55;
const HIGHLIGHT_OPACITY = 0.22;

// Phase 4 — crisp outline.
const OUTLINE_WIDTH = 1.5;
const OUTLINE_COLOR = 'rgba(0,0,0,0.45)';

// Texture sampling quality.
const TEX_ANISOTROPY = 4;

export function buildShapeTexture(style: ExtStyle): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;

  // Outline / soft glow underlay for crispness against dark backgrounds
  ctx.save();
  traceShape(ctx, style.shape);
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = SHADOW_BLUR;
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
      TEX_SIZE * HIGHLIGHT_X,
      TEX_SIZE * HIGHLIGHT_Y,
      HIGHLIGHT_INNER_RADIUS,
      TEX_SIZE * HIGHLIGHT_X,
      TEX_SIZE * HIGHLIGHT_Y,
      TEX_SIZE * HIGHLIGHT_RADIUS,
    );
    grad.addColorStop(0, `rgba(255,255,255,${HIGHLIGHT_OPACITY})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
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
