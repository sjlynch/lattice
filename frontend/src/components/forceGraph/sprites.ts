// Per-extension shape sprites for the 3D graph. This module is the public
// surface for sprite construction: material caching (`materialFor`) and
// sprite assembly (`spriteFor`). The two upstream stages live in their own
// modules and are re-exported here so existing importers keep a single
// entry point:
//   - `spriteShapes.ts`  — pure path geometry (`traceShape`) + `TEX_SIZE`.
//   - `spriteTextures.ts` — the multi-phase canvas → `CanvasTexture` render
//                           (`buildShapeTexture`).
// Each sprite is a CanvasTexture rendered to a TEX_SIZE square; we cache the
// SpriteMaterial per (extension, shape, color) tuple so the simulation only
// allocates once per kind regardless of how many nodes share that style.

import * as THREE from 'three';
import {
  DIR_STYLE,
  getStyleFor,
  styleKey,
  type ExtStyle,
} from '../../extensionStyles';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import { buildShapeTexture } from './spriteTextures';
import { NODE_RENDER_ORDER } from './renderOrders';

export { TEX_SIZE } from './spriteShapes';
export { buildShapeTexture } from './spriteTextures';

// Unbounded by line count but **structurally bounded**: the key is
// `styleKey(ExtStyle)` which is "extension + shape + colors", and that
// tuple is enumerated by `extensionStyles.ts` plus the
// per-overlay-color variants minted by `metricOverlayFactory`. In
// practice the cache caps at ~40 entries across a session and never
// grows with the file count. No LRU needed.
const materialCache = new Map<string, THREE.SpriteMaterial>();

export function materialFor(style: ExtStyle): THREE.SpriteMaterial {
  const key = styleKey(style);
  let mat = materialCache.get(key);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: buildShapeTexture(style),
      transparent: true,
      depthWrite: false,
      // Disable depth testing so the sprite is never occluded by link
      // lines, which share the transparent pass and can otherwise paint
      // on top of the billboard depending on camera z-order.
      depthTest: false,
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
  // three-forcegraph sets renderOrder=10 on link objects (LINK_RENDER_ORDER), so
  // sprites must be higher to render on top. Rings use RING_RENDER_ORDER (11),
  // the node body uses NODE_RENDER_ORDER (12).
  sprite.renderOrder = NODE_RENDER_ORDER;
  return sprite;
}
