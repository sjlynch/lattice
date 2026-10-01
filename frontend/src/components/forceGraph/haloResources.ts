// Shared selection-halo GPU resources. Nodes borrow module-owned materials;
// detaching a halo leaves these materials and textures alive for other nodes.

import * as THREE from 'three';
import { finishCanvasTexture, newTextureCanvas } from './canvasTexture';

const RING_COLOR = '#7ad0ff';
// The ring texture is drawn WHITE and tinted at render time by the shared
// material's `color` (multiplied against the texture in the shader): at rest
// the tint is RING_COLOR — reproducing the original look — while the pulse
// lerps it toward white. Drawing white rather than RING_COLOR is what lets the
// tint reach brighter-than-base values a color multiply otherwise can't.
const RING_TEXTURE_COLOR = '#ffffff';
export const RING_BASE_COLOR = new THREE.Color(RING_COLOR);

// Ring geometry, expressed as fractions of SIZE so the texture scales
// cleanly (the named-constant style of `changeRingTextures.ts`). The glow
// gradient peaks at the ring radius and the colored band spans
// RING_GRADIENT_INNER_STOP..RING_GRADIENT_OUTER_STOP of its sweep.
const SIZE = 128;
const RING_RADIUS = SIZE * 0.42;
// Thicker than the original 0.04 so selection rings read clearly in dense
// graphs; the soft glow band (RING_GLOW_SPREAD) scales with it automatically.
const RING_WIDTH = SIZE * 0.08;
const RING_GLOW_SPREAD = RING_WIDTH * 1.5;
const RING_GRADIENT_INNER_STOP = 0.45;
const RING_GRADIENT_OUTER_STOP = 0.55;
// Suffix appended to the ring texture color to give the soft glow band ~67% alpha.
const RING_GLOW_ALPHA = 'aa';

// Glow disc radial gradient: white alpha at the center, the midpoint stop and
// the edge.
const GLOW_CENTER_ALPHA = 0.9;
const GLOW_MID_STOP = 0.5;
const GLOW_MID_ALPHA = 0.35;
const GLOW_EDGE_ALPHA = 0;

let _ringTexture: THREE.CanvasTexture | null = null;
function ringTexture(): THREE.CanvasTexture {
  if (_ringTexture) return _ringTexture;
  const { canvas, ctx } = newTextureCanvas(SIZE);
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  // Soft glow so the ring still reads against a similarly-colored sprite.
  const grad = ctx.createRadialGradient(
    cx,
    cy,
    RING_RADIUS - RING_GLOW_SPREAD,
    cx,
    cy,
    RING_RADIUS + RING_GLOW_SPREAD,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(RING_GRADIENT_INNER_STOP, RING_TEXTURE_COLOR + RING_GLOW_ALPHA);
  grad.addColorStop(RING_GRADIENT_OUTER_STOP, RING_TEXTURE_COLOR + RING_GLOW_ALPHA);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Crisp thin solid stroke on top.
  ctx.beginPath();
  ctx.arc(cx, cy, RING_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = RING_TEXTURE_COLOR;
  ctx.lineWidth = RING_WIDTH;
  ctx.stroke();

  const tex = finishCanvasTexture(canvas);
  _ringTexture = tex;
  return tex;
}

let _ringMaterial: THREE.SpriteMaterial | null = null;
export function ringMaterial(): THREE.SpriteMaterial {
  if (_ringMaterial) return _ringMaterial;
  _ringMaterial = new THREE.SpriteMaterial({
    map: ringTexture(),
    // Start at the rest tint; the pulse animates this (see updateHaloPulse).
    color: RING_BASE_COLOR.clone(),
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  return _ringMaterial;
}

// Soft radial white disc, strongest at center and fading to transparent — the
// bloom drawn additively over the node body so a selected node brightens as the
// pulse raises this material's opacity.
let _glowTexture: THREE.CanvasTexture | null = null;
function glowTexture(): THREE.CanvasTexture {
  if (_glowTexture) return _glowTexture;
  const { canvas, ctx } = newTextureCanvas(SIZE);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE / 2);
  grad.addColorStop(0, `rgba(255,255,255,${GLOW_CENTER_ALPHA})`);
  grad.addColorStop(GLOW_MID_STOP, `rgba(255,255,255,${GLOW_MID_ALPHA})`);
  grad.addColorStop(1, `rgba(255,255,255,${GLOW_EDGE_ALPHA})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const tex = finishCanvasTexture(canvas);
  _glowTexture = tex;
  return tex;
}

let _glowMaterial: THREE.SpriteMaterial | null = null;
export function glowMaterial(): THREE.SpriteMaterial {
  if (_glowMaterial) return _glowMaterial;
  _glowMaterial = new THREE.SpriteMaterial({
    map: glowTexture(),
    // Additive so it *brightens* whatever node body it's drawn over rather than
    // occluding it. Starts fully transparent — the pulse raises the opacity.
    blending: THREE.AdditiveBlending,
    opacity: 0,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  return _glowMaterial;
}

// Pulse/reset borrow only already-created materials, without allocating canvases
// or GPU resources before the first halo is built.
export function peekRingMaterial(): THREE.SpriteMaterial | null {
  return _ringMaterial;
}

export function peekGlowMaterial(): THREE.SpriteMaterial | null {
  return _glowMaterial;
}
