import * as THREE from 'three';

export type SpriteUvBounds = {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
};

// THREE.Sprite raycasting uses the sprite's full rectangular quad, including
// transparent canvas padding. Overlay labels are intentionally drawn on
// transparent canvases, so clamp the hit-test to the text-bearing UV region to
// avoid a nearby label stealing hover/clicks with invisible pixels.
export function restrictSpriteRaycast(
  sprite: THREE.Sprite,
  bounds: SpriteUvBounds,
): void {
  const baseRaycast = sprite.raycast.bind(sprite);
  sprite.raycast = (raycaster, intersects) => {
    const start = intersects.length;
    baseRaycast(raycaster, intersects);
    for (let i = intersects.length - 1; i >= start; i--) {
      const uv = intersects[i].uv;
      if (!uv) continue;
      if (
        uv.x < bounds.minU ||
        uv.x > bounds.maxU ||
        uv.y < bounds.minV ||
        uv.y > bounds.maxV
      ) {
        intersects.splice(i, 1);
      }
    }
  };
}

// Connector lines are visual guides, not targets. Leaving their default line
// raycast enabled makes hover selection feel random in dense overlay clusters:
// a thin line can capture the pointer for a node that is not under the cursor.
export function disableRaycast(obj: THREE.Object3D): void {
  obj.raycast = () => {};
}
