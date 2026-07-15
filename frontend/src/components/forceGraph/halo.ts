// Selection halo. Drawn as a sibling child of the node's root Group so it can
// be toggled in/out per-id without rebuilding the node's THREE objects — see
// `setNodeHalo` below. Two parts, each a single shared material so a graph with
// N selected nodes still allocates exactly one GPU resource per part:
//   - a ring below the node body (an outline around the node), and
//   - an additive white glow over the node body that pulses to brighten the
//     node itself.
// The pulse (`updateHaloPulse`) animates both shared materials at once, so
// animating the whole selection is O(1) per frame regardless of selection size.

import * as THREE from 'three';
import { RING_RENDER_ORDER, SELECTION_GLOW_RENDER_ORDER } from './renderOrders';

const RING_COLOR = '#7ad0ff';
// The ring texture is drawn WHITE and tinted at render time by the shared
// material's `color` (multiplied against the texture in the shader): at rest
// the tint is RING_COLOR — reproducing the original look — while the pulse
// lerps it toward white. Drawing white rather than RING_COLOR is what lets the
// tint reach brighter-than-base values a color multiply otherwise can't.
const RING_TEXTURE_COLOR = '#ffffff';
// Pulse: the shared ring material's tint oscillates RING_COLOR ⇄ white and the
// shared glow material's opacity oscillates 0 ⇄ peak, in lock-step, so the ring
// brightens/whitens and the node itself brightens then dims back — staying
// legible in dense graphs. One material each tints every halo, so the animation
// is O(1) per frame no matter how many nodes are selected.
const RING_BASE_COLOR = new THREE.Color(RING_COLOR);
const RING_BRIGHT_COLOR = new THREE.Color(0xffffff);
const PULSE_PERIOD_MS = 1100;
const PULSE_PEAK = 0.85; // max ring lerp toward white (1 = fully white)

// The two glow knobs surfaced on the Rendering tab (`selectionGlowStrength` /
// `selectionGlowScale` in GraphSettings). Live-mutable via `configureSelectionGlow`;
// initialized to the same values as DEFAULT_SETTINGS so a halo built before
// settings load still looks right. `_glowPeakOpacity` is read live each frame by
// `updateHaloPulse`; `_glowScale` is read when a halo is built (`buildHaloGroup`),
// so a change to it rebuilds the current selection's halos (see selectionHaloSync).
let _glowPeakOpacity = 0.5; // max additive-white strength over the node body
let _glowScale = 1.5; // bloom radius as a multiple of node base size

// Push the Rendering-tab glow knobs into this module. Called on settings load
// and whenever the sliders move (see hooks/useSelectionGlowSettings).
export function configureSelectionGlow(opts: {
  strength: number;
  scale: number;
}): void {
  _glowPeakOpacity = opts.strength;
  _glowScale = opts.scale;
}

// Tag used on the halo Group's `userData` so `setNodeHalo(off)` can locate the
// existing halo (ring + glow) without iterating the whole child list.
const HALO_TAG = 'lattice:halo';

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

// Ring scale, as a multiple of the node's base size. Larger than the change
// ring (1.6×) so a changed+selected node shows both concentrically. (The glow's
// scale is the live-tunable `_glowScale` above.)
const RING_SCALE = 1.8;

let _ringTexture: THREE.CanvasTexture | null = null;
function ringTexture(): THREE.CanvasTexture {
  if (_ringTexture) return _ringTexture;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
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
  grad.addColorStop(RING_GRADIENT_INNER_STOP, RING_TEXTURE_COLOR + 'aa');
  grad.addColorStop(RING_GRADIENT_OUTER_STOP, RING_TEXTURE_COLOR + 'aa');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Crisp thin solid stroke on top.
  ctx.beginPath();
  ctx.arc(cx, cy, RING_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = RING_TEXTURE_COLOR;
  ctx.lineWidth = RING_WIDTH;
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _ringTexture = tex;
  return tex;
}

let _ringMaterial: THREE.SpriteMaterial | null = null;
function ringMaterial(): THREE.SpriteMaterial {
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
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _glowTexture = tex;
  return tex;
}

let _glowMaterial: THREE.SpriteMaterial | null = null;
function glowMaterial(): THREE.SpriteMaterial {
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

// Advance the shared halo pulse to time `nowMs`: tint the single ring material
// between RING_COLOR and white and raise the single glow material's opacity,
// both on the same smooth sine. O(1): the two shared materials recolor every
// mounted halo at once. No-op until a halo exists. Driven each render frame by
// `useSelectionHaloPulse` (which keeps the render loop alive via the idle
// controller's `halo` reason while a selection is up).
export function updateHaloPulse(nowMs: number): void {
  // (1 - cos)/2 ramps 0→1→0 with eased ends over one period.
  const t = (nowMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  const wave = (1 - Math.cos(t * Math.PI * 2)) / 2;
  if (_ringMaterial) {
    _ringMaterial.color
      .copy(RING_BASE_COLOR)
      .lerp(RING_BRIGHT_COLOR, wave * PULSE_PEAK);
  }
  if (_glowMaterial) _glowMaterial.opacity = wave * _glowPeakOpacity;
}

// Restore the halo to its rest state (base ring tint, glow off). Called when the
// selection clears so a halo that lingers into the next selection isn't frozen
// mid-pulse at a random brightness.
export function resetHaloPulse(): void {
  if (_ringMaterial) _ringMaterial.color.copy(RING_BASE_COLOR);
  if (_glowMaterial) _glowMaterial.opacity = 0;
}

// The halo is a Group (ring + glow) so both toggle atomically as one tagged
// sibling child of the node root — the delta walker adds/removes a single
// object, and the two sprites keep independent renderOrders (ring below the
// body, glow above) regardless of the parent Group.
function buildHaloGroup(baseSize: number): THREE.Group {
  const group = new THREE.Group();
  group.userData[HALO_TAG] = true;

  // Ring: below the node body (RING_RENDER_ORDER) so the body paints over the
  // inner disc, leaving a colored outline. Larger than the change ring so a
  // changed+selected node shows both concentrically.
  const ring = new THREE.Sprite(ringMaterial());
  const rs = baseSize * RING_SCALE;
  ring.scale.set(rs, rs, 1);
  ring.renderOrder = RING_RENDER_ORDER;
  group.add(ring);

  // Glow: additive white bloom just above the node body so the node itself
  // brightens as the pulse raises the shared glow material's opacity.
  const glow = new THREE.Sprite(glowMaterial());
  const gs = baseSize * _glowScale;
  glow.scale.set(gs, gs, 1);
  glow.renderOrder = SELECTION_GLOW_RENDER_ORDER;
  group.add(glow);

  return group;
}

function findHaloChild(root: THREE.Object3D): THREE.Object3D | null {
  // child counts are tiny (root + base + optional halo); a direct scan
  // beats keeping a side map and the userData check is O(1).
  for (const child of root.children) {
    if (child.userData[HALO_TAG]) return child;
  }
  return null;
}

// Toggle the selection halo (ring + glow) as a sibling child of the node's root
// Group. Called from the selection-change handler instead of `graph.refresh()`
// — we touch only the affected nodes' THREE objects, so the cost is O(delta)
// not O(nodes).
export function setNodeHalo(
  root: THREE.Object3D,
  selected: boolean,
  baseSize: number,
): void {
  const existing = findHaloChild(root);
  if (selected) {
    if (existing) return;
    root.add(buildHaloGroup(baseSize));
  } else {
    if (!existing) return;
    root.remove(existing);
  }
}
