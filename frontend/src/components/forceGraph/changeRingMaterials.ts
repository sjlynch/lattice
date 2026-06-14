// SpriteMaterial caches for the change-ring overlay. Mirrors the explicit
// cache-map pattern in `sprites.ts`: each material (and its backing
// texture) is built once and reused, so a graph with thousands of changed
// nodes still allocates exactly four GPU resources — three rings + one
// ghost disc.

import * as THREE from 'three';
import {
  buildRingTexture,
  buildGhostTexture,
  type ChangeKind,
} from './changeRingTextures';

// Shared sprite-material flags: transparent billboards that never occlude
// or get occluded by neighboring sprites/link lines.
const SPRITE_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
  depthTest: false,
} as const;

const ringMaterialCache = new Map<ChangeKind, THREE.SpriteMaterial>();

export function ringMaterial(kind: ChangeKind): THREE.SpriteMaterial {
  let mat = ringMaterialCache.get(kind);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: buildRingTexture(kind),
      ...SPRITE_MATERIAL_OPTS,
    });
    ringMaterialCache.set(kind, mat);
  }
  return mat;
}

// Single ghost material — keyed in a map purely to mirror the ring cache;
// there is only ever one entry, built lazily on first use.
const ghostMaterialCache = new Map<'ghost', THREE.SpriteMaterial>();

export function ghostMaterial(): THREE.SpriteMaterial {
  let mat = ghostMaterialCache.get('ghost');
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: buildGhostTexture(),
      ...SPRITE_MATERIAL_OPTS,
    });
    ghostMaterialCache.set('ghost', mat);
  }
  return mat;
}
