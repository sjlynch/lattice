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
import { DEFAULT_SETTINGS } from './graphSettings';
import {
  RING_BASE_COLOR,
  ringMaterial,
  glowMaterial,
  peekRingMaterial,
  peekGlowMaterial,
} from './haloResources';
import { RING_RENDER_ORDER, SELECTION_GLOW_RENDER_ORDER } from './renderOrders';

// Pulse: the shared ring material's tint oscillates RING_COLOR ⇄ white and the
// shared glow material's opacity oscillates 0 ⇄ peak, in lock-step, so the ring
// brightens/whitens and the node itself brightens then dims back — staying
// legible in dense graphs. One material each tints every halo, so the animation
// is O(1) per frame no matter how many nodes are selected.
const RING_BRIGHT_COLOR = new THREE.Color(0xffffff);
const PULSE_PERIOD_MS = 1100;
const PULSE_PEAK = 0.85; // max ring lerp toward white (1 = fully white)

// The two glow knobs surfaced on the Rendering tab (`selectionGlowStrength` /
// `selectionGlowScale` in GraphSettings). Live-mutable via `configureSelectionGlow`;
// initialized from DEFAULT_SETTINGS so a halo built before settings load still
// looks right. `_glowPeakOpacity` is read live each frame by
// `updateHaloPulse`; `_glowScale` is read when a halo is built (`buildHaloGroup`),
// so a change to it rebuilds the current selection's halos (see selectionHaloSync).
// max additive-white strength over the node body
let _glowPeakOpacity = DEFAULT_SETTINGS.selectionGlowStrength;
// bloom radius as a multiple of node base size
let _glowScale = DEFAULT_SETTINGS.selectionGlowScale;

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

// Ring scale, as a multiple of the node's base size. Larger than the change
// ring (1.6×) so a changed+selected node shows both concentrically. (The glow's
// scale is the live-tunable `_glowScale` above.)
const RING_SCALE = 1.8;

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
  const ring = peekRingMaterial();
  if (ring) {
    ring.color
      .copy(RING_BASE_COLOR)
      .lerp(RING_BRIGHT_COLOR, wave * PULSE_PEAK);
  }
  const glow = peekGlowMaterial();
  if (glow) glow.opacity = wave * _glowPeakOpacity;
}

// Restore the halo to its rest state (base ring tint, glow off). Called when the
// selection clears so a halo that lingers into the next selection isn't frozen
// mid-pulse at a random brightness.
export function resetHaloPulse(): void {
  const ring = peekRingMaterial();
  if (ring) ring.color.copy(RING_BASE_COLOR);
  const glow = peekGlowMaterial();
  if (glow) glow.opacity = 0;
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
