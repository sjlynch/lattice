import * as THREE from 'three';
import type { MeasuredLabelTexture } from './labelTexture';
import {
  disableRaycast,
  restrictSpriteRaycast,
  type SpriteUvBounds,
} from './spritePicking';

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

// --- Module-owned shared caches (Part A) ------------------------------------
// Toggling a metric/Alt overlay calls graph.refresh(), which rebuilds every
// node object. Without these caches that re-allocates — per file node — a
// SpriteMaterial, a LineBasicMaterial wrapping a THREE.Color, and a connector
// BufferGeometry, i.e. thousands of THREE allocations per toggle (with the old
// objects orphaned without GPU disposal). These caches reuse the immutable
// pieces across rebuilds.
//
// INVARIANT: every resource cached here is module-owned and must NEVER be
// disposed per-node. A per-node teardown (e.g. labelsOverlay.disposeLabelEntry)
// may free ONLY the resources it solely owns — the per-line cloned connector
// geometry — never these shared materials/colors/templates (or the shared label
// textures from labelTexture.ts).

// A floating-label SpriteMaterial depends only on its texture map
// (transparent/depthWrite:false/depthTest:false are constant), and the texture
// is itself cached, so every sprite drawn over the same label texture can share
// one material. WeakMap keyed by texture: an evicted/GC'd texture takes its
// material with it, so the cache can't outgrow the (bounded) texture set.
const labelMaterialCache = new WeakMap<MeasuredLabelTexture, THREE.SpriteMaterial>();

function cachedLabelMaterial(texture: MeasuredLabelTexture): THREE.SpriteMaterial {
  let mat = labelMaterialCache.get(texture);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    labelMaterialCache.set(texture, mat);
  }
  return mat;
}

// THREE.Color cached by hex string (the connector materials only ever read it).
const colorCache = new Map<string, THREE.Color>();
function cachedColor(hex: string): THREE.Color {
  let color = colorCache.get(hex);
  if (!color) {
    color = new THREE.Color(hex);
    colorCache.set(hex, color);
  }
  return color;
}

// Connector LineBasicMaterial cached by (color, opacity) — the only fields that
// vary between callers — since nothing mutates it after creation.
const lineMaterialCache = new Map<string, THREE.LineBasicMaterial>();
function cachedLineMaterial(color: string, opacity: number): THREE.LineBasicMaterial {
  const key = `${color}|${opacity}`;
  let mat = lineMaterialCache.get(key);
  if (!mat) {
    mat = new THREE.LineBasicMaterial({
      color: cachedColor(color),
      transparent: true,
      opacity,
    });
    lineMaterialCache.set(key, mat);
  }
  return mat;
}

// Connector geometry template cached by its (constant) endpoints. Every line in
// an overlay shares the same endpoints, but the repulsion step mutates each
// line's upper endpoint per-frame, so each line gets its OWN clone of the
// template — the clone just skips the per-line Vector3/setFromPoints allocations
// the template already paid once.
const connectorGeometryTemplates = new Map<string, THREE.BufferGeometry>();
function connectorGeometryTemplate(
  nodeAnchorY: number,
  labelY: number,
  labelGap: number,
): THREE.BufferGeometry {
  const key = `${nodeAnchorY}|${labelY}|${labelGap}`;
  let geom = connectorGeometryTemplates.get(key);
  if (!geom) {
    geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, nodeAnchorY, 0),
      new THREE.Vector3(0, labelY - labelGap, 0),
    ]);
    connectorGeometryTemplates.set(key, geom);
  }
  return geom;
}

// Camera/world-position delta below which the per-frame scale recompute is
// skipped (Part C). The scale is a pure function of camera distance, so when
// nothing moved beyond this it's unchanged; small enough to be sub-pixel.
const SCALE_RECOMPUTE_EPS = 0.01;

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
  sprite.renderOrder = config.renderOrder ?? 999;

  const minScale = config.minScale ?? 6;
  const refDistance = config.refDistance ?? 200;
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
    const d = camera.position.distanceTo(_pos);
    const s = Math.max(minScale, Math.min(config.maxScale, (d / refDistance) * h));
    sprite.scale.set(s * aspect, s, 1);
  };

  return sprite;
}

export function makeConnectorLine(config: ConnectorLineConfig): THREE.Line {
  const nodeAnchorY = config.nodeAnchorY ?? 3;
  const labelGap = config.labelGap ?? 4;
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
