// Shared canvas → CanvasTexture plumbing for the graph's hand-painted sprites
// (file shapes, change/worktree/selection rings, agent nodes, labels). Every
// site used to repeat "create a canvas → draw → new CanvasTexture → linear
// filters + sRGB + needsUpdate"; the draw step stays with each caller.
//
// `colorSpace = SRGBColorSpace` is load-bearing: the canvas paints sRGB byte
// values, and without the hint three.js treats them as linear, double-encodes
// on output, and sprite colors come out washed out instead of matching the
// legend exactly.

import * as THREE from 'three';

export type TextureCanvas = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
};

// A fresh `width`×`height` canvas (square by default) and its 2D context.
export function newTextureCanvas(width: number, height: number = width): TextureCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d')! };
}

export type FinishCanvasTextureOptions = {
  // Anisotropic filtering level; left at three.js's default when omitted.
  anisotropy?: number;
};

// Wrap a painted canvas in a CanvasTexture with linear min/mag filtering and
// the sRGB color space, flagged for upload.
export function finishCanvasTexture(
  canvas: HTMLCanvasElement,
  opts: FinishCanvasTextureOptions = {},
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if (opts.anisotropy !== undefined) tex.anisotropy = opts.anisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// CSS `rgba()` for a THREE color at alpha `a`, for canvas gradient stops and
// fills (agent discs, worktree rings).
export function rgba(c: THREE.Color, a: number): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
