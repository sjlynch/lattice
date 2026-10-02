// SpriteMaterial caches for the change-ring overlay, on the shared cache
// helper (`spriteMaterialCache.ts`, as in `sprites.ts`): each material (and
// its backing texture) is built once and reused, so a graph with thousands of
// changed nodes still allocates exactly four GPU resources — three rings + one
// ghost disc. Disposed and emptied on graph teardown.

import * as THREE from 'three';
import {
  buildRingTexture,
  buildGhostTexture,
  type ChangeKind,
} from './changeRingTextures';
import { createSpriteMaterialCache } from './spriteMaterialCache';

// Shared sprite-material flags: transparent billboards that never occlude
// or get occluded by neighboring sprites/link lines.
const SPRITE_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
  depthTest: false,
} as const;

const ringMaterialCache = createSpriteMaterialCache<ChangeKind>();

export function ringMaterial(kind: ChangeKind): THREE.SpriteMaterial {
  return ringMaterialCache.get(kind, () =>
    new THREE.SpriteMaterial({
      map: buildRingTexture(kind),
      ...SPRITE_MATERIAL_OPTS,
    }),
  );
}

// Single ghost material — there is only ever one; a one-key cache gives it the
// same graph-teardown disposal as the rings.
const ghostMaterialCache = createSpriteMaterialCache<'ghost'>();

export function ghostMaterial(): THREE.SpriteMaterial {
  return ghostMaterialCache.get('ghost', () =>
    new THREE.SpriteMaterial({
      map: buildGhostTexture(),
      ...SPRITE_MATERIAL_OPTS,
    }),
  );
}
