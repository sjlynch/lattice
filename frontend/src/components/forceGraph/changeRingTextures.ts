// Canvas-texture builders for the change-ring overlay. Each texture is a
// TEX_SIZE square painted once and cached by the material layer
// (`changeRingMaterials.ts`). All the geometry/opacity magic numbers that
// used to be scattered inline now live here as named constants.

import * as THREE from 'three';

export type ChangeKind = 'added' | 'modified' | 'deleted';

export const RING_COLORS: Record<ChangeKind, string> = {
  added: '#46d27a',
  modified: '#e5c046',
  deleted: '#f57878',
};

// Shared square canvas size for both the ring and ghost textures.
const TEX_SIZE = 128;

// Ring geometry, expressed as fractions of TEX_SIZE so the texture scales
// cleanly. The glow gradient peaks at the ring radius and the colored band
// spans GRADIENT_INNER_STOP..GRADIENT_OUTER_STOP of its sweep.
const RING_RADIUS = TEX_SIZE * 0.42;
const RING_WIDTH = TEX_SIZE * 0.09;
const RING_GLOW_SPREAD = RING_WIDTH * 1.5;
const RING_GRADIENT_INNER_STOP = 0.45;
const RING_GRADIENT_OUTER_STOP = 0.55;
// Suffix appended to the ring color to give the soft glow band ~87% alpha.
const RING_GLOW_ALPHA = 'dd';

// Ghost (deleted) disc: a small grey circle inset from the canvas edge.
const GHOST_RADIUS = TEX_SIZE / 2 - 14;
const GHOST_FILL = 'rgba(110, 116, 125, 0.55)';
const GHOST_STROKE = 'rgba(0,0,0,0.4)';
const GHOST_STROKE_WIDTH = 1.5;

function newTextureCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  return { canvas, ctx: canvas.getContext('2d')! };
}

function finishTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Colored ring with a soft outer glow so it reads against a similarly-
// colored sprite, plus a crisp solid stroke so the outline stays sharp at
// all zooms.
export function buildRingTexture(kind: ChangeKind): THREE.CanvasTexture {
  const { canvas, ctx } = newTextureCanvas();
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;

  const grad = ctx.createRadialGradient(
    cx,
    cy,
    RING_RADIUS - RING_GLOW_SPREAD,
    cx,
    cy,
    RING_RADIUS + RING_GLOW_SPREAD,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(RING_GRADIENT_INNER_STOP, RING_COLORS[kind] + RING_GLOW_ALPHA);
  grad.addColorStop(RING_GRADIENT_OUTER_STOP, RING_COLORS[kind] + RING_GLOW_ALPHA);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  ctx.beginPath();
  ctx.arc(cx, cy, RING_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = RING_COLORS[kind];
  ctx.lineWidth = RING_WIDTH;
  ctx.stroke();

  return finishTexture(canvas);
}

// Small grey disc drawn in place of a normal file node so deleted files
// read as "ghosts" at a glance.
export function buildGhostTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = newTextureCanvas();
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, GHOST_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = GHOST_FILL;
  ctx.fill();
  ctx.lineWidth = GHOST_STROKE_WIDTH;
  ctx.strokeStyle = GHOST_STROKE;
  ctx.stroke();

  return finishTexture(canvas);
}
