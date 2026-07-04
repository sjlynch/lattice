import * as THREE from 'three';
import type { MeasuredLabelTexture } from './labelTexture';

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

export function cachedLabelMaterial(texture: MeasuredLabelTexture): THREE.SpriteMaterial {
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

// Dispose and forget the cached SpriteMaterial paired with `texture`, if any.
// The material is keyed by — and only useful with — that one texture, so when a
// label texture is evicted/disposed (labelTexture.ts) the two are freed
// together. A no-op when no material was ever built for the texture.
export function disposeLabelMaterial(texture: MeasuredLabelTexture): void {
  const mat = labelMaterialCache.get(texture);
  if (mat) {
    mat.dispose();
    labelMaterialCache.delete(texture);
  }
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
export function cachedLineMaterial(color: string, opacity: number): THREE.LineBasicMaterial {
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
export function connectorGeometryTemplate(
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
