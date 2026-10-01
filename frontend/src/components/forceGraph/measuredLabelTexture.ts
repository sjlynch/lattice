import { finishCanvasTexture, newTextureCanvas } from './canvasTexture';
import type { LabelTextureOptions, MeasuredLabelTexture } from './labelTexture';

// Shared offscreen 2D context used only for measureText on cache misses.
// Creating a <canvas> + 2D context is one of the costlier DOM allocations;
// measureText is deterministic given ctx.font, so a single reused probe yields
// identical metrics while avoiding a throwaway canvas per miss. Created lazily
// (rather than at module load) so importing this module never touches the DOM —
// it stays usable from non-DOM contexts (tests) and only pays the allocation
// once a real miss needs measuring.
let measureCtxCache: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!measureCtxCache) {
    measureCtxCache = document.createElement('canvas').getContext('2d')!;
  }
  return measureCtxCache;
}

function measuredTextWidth(metrics: TextMetrics): number {
  const actual = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
  return Math.ceil(actual > 0 ? actual : metrics.width);
}

// Draw a fresh texture; labelTexture.ts owns its cache entry and lifetime.
export function drawMeasuredLabelTexture(
  text: string,
  color: string,
  options: LabelTextureOptions,
): MeasuredLabelTexture {
  const ctx = measureCtx();
  ctx.font = options.font;
  const measured = measuredTextWidth(ctx.measureText(text));
  const visualW = measured + options.strokeWidth + 2;
  const W = Math.max(options.minWidth, visualW + options.padX * 2);

  const { canvas, ctx: drawCtx } = newTextureCanvas(W, options.height);

  drawCtx.font = options.font;
  drawCtx.textAlign = 'center';
  drawCtx.textBaseline = 'middle';
  drawCtx.lineJoin = 'round';
  drawCtx.lineWidth = options.strokeWidth;
  drawCtx.strokeStyle = options.strokeStyle ?? 'rgba(0,0,0,0.85)';
  drawCtx.strokeText(text, W / 2, options.height / 2);
  drawCtx.fillStyle = color;
  drawCtx.fillText(text, W / 2, options.height / 2);

  const tex = finishCanvasTexture(canvas) as MeasuredLabelTexture;
  tex._aspect = W / options.height;

  const hitW = Math.min(W, visualW + options.padX);
  tex._hitBounds = {
    minU: Math.max(0, (W - hitW) / 2 / W),
    maxU: Math.min(1, 1 - (W - hitW) / 2 / W),
    minV: options.minV ?? 0.12,
    maxV: options.maxV ?? 0.88,
  };

  return tex;
}
