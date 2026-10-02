import * as THREE from 'three';
import type { MeasuredLabelTexture } from './labelTexture';
import {
  disableRaycast,
  restrictSpriteRaycast,
  type SpriteUvBounds,
} from './spritePicking';
import { FLOATING_LABEL_RENDER_ORDER } from './renderOrders';
import {
  cachedLabelMaterial,
  cachedLineMaterial,
  connectorGeometryTemplate,
} from './labelSpriteResources';

const DEFAULT_HIT_BOUNDS = {
  minU: 0,
  maxU: 1,
  minV: 0,
  maxV: 1,
};

export type FloatingLabelSpriteConfig = {
  heightMultiplier: number;
  maxScale: number;
  aspectFallback: number;
  minScale?: number;
  refDistance?: number;
  renderOrder?: number;
  hitBounds?: SpriteUvBounds;
};

export type ConnectorLineConfig = {
  color: string;
  labelY: number;
  opacity: number;
  nodeAnchorY?: number;
  labelGap?: number;
};

export type FloatingLabelEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};

// The label material / color / line material / connector geometry caches these
// factories draw on live in labelSpriteResources.ts (with the module-ownership
// INVARIANT documented there): never dispose a shared cached resource per-node.

// Camera/world-position delta below which the per-frame scale recompute is
// skipped (Part C). The scale is a pure function of camera distance, so when
// nothing moved beyond this it's unchanged; small enough to be sub-pixel.
const SCALE_RECOMPUTE_EPS = 0.01;
// Minimum screen-facing label scale when no caller override is supplied.
const DEFAULT_MIN_SCALE = 6;
// Camera-distance reference used to grow labels when no caller override exists.
const DEFAULT_REF_DISTANCE = 200;
// Connector start Y on the node when no caller-specific anchor is supplied.
const DEFAULT_NODE_ANCHOR_Y = 3;
// Gap between connector endpoint and label baseline when no override is supplied.
const DEFAULT_LABEL_GAP = 4;

// The camera-distance-driven height (world units) a floating label is drawn at:
// `baseH * heightMultiplier` at `refDistance`, growing linearly with distance so
// it reads at a roughly constant on-screen size, clamped to [minScale,maxScale].
// Shared by the sprite's own onBeforeRender and by layouts that must know a
// label's size BEFORE it renders (the agent label spreader, which runs from the
// scene's onBeforeRender — ahead of the sprite's own scale update).
export function floatingLabelHeight(
  distance: number,
  baseH: number,
  config: FloatingLabelSpriteConfig,
): number {
  const h = baseH * config.heightMultiplier;
  const minScale = config.minScale ?? DEFAULT_MIN_SCALE;
  const refDistance = config.refDistance ?? DEFAULT_REF_DISTANCE;
  return Math.max(minScale, Math.min(config.maxScale, (distance / refDistance) * h));
}

export function makeFloatingLabelSprite(
  texture: MeasuredLabelTexture,
  baseH: number,
  config: FloatingLabelSpriteConfig,
): THREE.Sprite {
  const aspect = texture._aspect ?? config.aspectFallback;
  const mat = cachedLabelMaterial(texture);
  const h = baseH * config.heightMultiplier;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(h * aspect, h, 1);
  restrictSpriteRaycast(
    sprite,
    config.hitBounds ?? texture._hitBounds ?? DEFAULT_HIT_BOUNDS,
  );
  sprite.renderOrder = config.renderOrder ?? FLOATING_LABEL_RENDER_ORDER;

  const _pos = new THREE.Vector3();
  // Memoised camera + label world position from the last scale recompute (NaN
  // until the first render, which always computes). When neither moved beyond
  // SCALE_RECOMPUTE_EPS since last frame the camera distance is unchanged, so we
  // early-return — skipping the distanceTo() sqrt and the scale.set(). (Part C.)
  let lastCamX = NaN;
  let lastCamY = NaN;
  let lastCamZ = NaN;
  let lastWorldX = NaN;
  let lastWorldY = NaN;
  let lastWorldZ = NaN;
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    sprite.getWorldPosition(_pos);
    const cam = camera.position;
    if (
      Math.abs(cam.x - lastCamX) <= SCALE_RECOMPUTE_EPS &&
      Math.abs(cam.y - lastCamY) <= SCALE_RECOMPUTE_EPS &&
      Math.abs(cam.z - lastCamZ) <= SCALE_RECOMPUTE_EPS &&
      Math.abs(_pos.x - lastWorldX) <= SCALE_RECOMPUTE_EPS &&
      Math.abs(_pos.y - lastWorldY) <= SCALE_RECOMPUTE_EPS &&
      Math.abs(_pos.z - lastWorldZ) <= SCALE_RECOMPUTE_EPS
    ) {
      return;
    }
    lastCamX = cam.x;
    lastCamY = cam.y;
    lastCamZ = cam.z;
    lastWorldX = _pos.x;
    lastWorldY = _pos.y;
    lastWorldZ = _pos.z;
    const s = floatingLabelHeight(camera.position.distanceTo(_pos), baseH, config);
    sprite.scale.set(s * aspect, s, 1);
  };

  return sprite;
}

export function makeConnectorLine(config: ConnectorLineConfig): THREE.Line {
  const nodeAnchorY = config.nodeAnchorY ?? DEFAULT_NODE_ANCHOR_Y;
  const labelGap = config.labelGap ?? DEFAULT_LABEL_GAP;
  // Per-line clone of the shared template (its upper endpoint is mutated each
  // frame by the repulsion step, so it can't be shared as one instance).
  const lineGeom = connectorGeometryTemplate(
    nodeAnchorY,
    config.labelY,
    labelGap,
  ).clone();
  const lineMat = cachedLineMaterial(config.color, config.opacity);
  const line = new THREE.Line(lineGeom, lineMat);
  disableRaycast(line);
  return line;
}

// Free the one GPU resource a registry entry solely owns: the per-line clone of
// the connector geometry template (made by makeConnectorLine). The label
// texture, the sprite material (shared per texture) and the connector line
// material (shared per color) are all module-owned caches in
// labelSpriteResources.ts — disposing any of those here would break every other
// label still using them (that module's INVARIANT). This is the same teardown
// labelsOverlay's Alt overlay does per node; it's exported so the metric
// overlays (LOC/health) share one definition.
export function disposeLabelEntry(entry: FloatingLabelEntry): void {
  entry.line.geometry.dispose();
}

// Dispose every entry's cloned connector geometry, then empty the registry.
// Geometry only: it releases no label-texture refcounts, so the overlay
// registries go through `clearAllLabelRegistries` (hooks/refresh.ts) instead.
// For node objects the library replaces, the dispose is a harmless repeat:
// three-forcegraph's `onRemoveObj` → `_deallocate` recursively disposes every
// removed object's geometry, material and `material.map` on `graph.refresh()`
// and on a `graphData()` swap, and three-render-objects' `emptyObject` does the
// same to the whole scene on `_destructor`. Disposing is idempotent; a line
// removed outside a digest (the Alt delta walker's per-node label toggle) is
// not deallocated by the library and still needs it.
export function disposeAndClearRegistry(registry: Set<FloatingLabelEntry>): void {
  for (const entry of registry) disposeLabelEntry(entry);
  registry.clear();
}
