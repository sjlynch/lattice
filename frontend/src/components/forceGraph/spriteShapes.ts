// Pure shape geometry for the per-extension graph sprites. `traceShape`
// lays a closed path on a 2D canvas context; it owns *only* the geometry,
// no fills/strokes/colors — those belong to the texture pipeline in
// `spriteTextures.ts`. The shapes are sized to fit a TEX_SIZE canvas.

import type { Shape } from '../../extensionStyles';

export const TEX_SIZE = 128;

// Safety margin between the shape's bounding circle and the canvas edge so
// antialiased edges (and the soft drop-shadow underlay) aren't clipped.
const EDGE_MARGIN = 8;

// The rounded square is drawn larger than the inscribing radius `r` so it
// reads as roughly the same visual weight as the circle/diamond; SQUARE_SIDE
// scales `r` to the side length and SQUARE_CORNER scales that side to the
// corner-arc radius.
const SQUARE_SIDE = 1.78;
const SQUARE_CORNER = 0.16;

// The triangle is squashed vertically so its tall pointy-top apex doesn't
// blow past the other shapes' footprint.
const TRIANGLE_Y_SCALE = 0.95;

// Trace a closed shape path on `ctx`, sized to fit a TEX_SIZE canvas with
// a small safety margin so antialiased edges aren't clipped.
export function traceShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  const r = TEX_SIZE / 2 - EDGE_MARGIN;
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case 'square': {
      const side = r * SQUARE_SIDE;
      const x0 = cx - side / 2;
      const y0 = cy - side / 2;
      const rr = side * SQUARE_CORNER;
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
        const y = cy + r * TRIANGLE_Y_SCALE * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
  }
}
