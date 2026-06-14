// Change-rings overlay for the timeline scrubber. Wraps a node sprite in
// a colored ring sprite (added=green, modified=yellow, deleted=red) and,
// for the deleted case, swaps the underlying sprite for a smaller grey
// disc so removed files read as "ghosts" without the user having to
// inspect the ring color.
//
// This module is a thin facade over the texture/material split:
//   - changeRingTextures.ts — canvas-texture builders + named constants
//   - changeRingMaterials.ts — cached SpriteMaterials (3 rings + 1 ghost)
// so a graph with thousands of changed nodes still allocates exactly four
// GPU resources. Public API (withChangeRing, deletedSprite, ChangeKind)
// lives here.

import * as THREE from 'three';
import { ringMaterial, ghostMaterial } from './changeRingMaterials';
import type { ChangeKind } from './changeRingTextures';

export type { ChangeKind } from './changeRingTextures';

// Tag set on every timeline change-ring sprite so the `W` worktree overlay
// can momentarily hide them (the two ring styles are hard to tell apart
// when stacked, so worktree view suppresses change rings while held).
const CHANGE_RING_TAG = 'lattice:changeRing';

// Hide / show all timeline change-ring sprites under a node's root Group.
// Walks descendants because the change ring is nested inside the base
// composite group, not a direct child of the root.
export function setNodeChangeRingsVisible(
  root: THREE.Object3D,
  visible: boolean,
): void {
  root.traverse((obj) => {
    if (obj.userData[CHANGE_RING_TAG]) obj.visible = visible;
  });
}

// Wrap an existing sprite in a parent group with a colored ring sprite
// behind it. The ring sits at renderOrder=0 so the source sprite (which
// is renderOrder>=1) paints over the inner part of the disc.
export function withChangeRing(
  child: THREE.Object3D,
  baseSize: number,
  kind: ChangeKind,
): THREE.Object3D {
  const group = new THREE.Group();
  const ring = new THREE.Sprite(ringMaterial(kind));
  // Ring slightly larger than the node so it reads as an outline, not
  // an overlay.
  const s = baseSize * 1.6;
  ring.scale.set(s, s, 1);
  ring.renderOrder = 11;
  ring.userData[CHANGE_RING_TAG] = true;
  group.add(ring);
  group.add(child);
  return group;
}

// Render a "deleted" node from scratch: small grey disc + red ring.
// Used for files that no longer exist in the working tree but were
// alive at some point inside the scrubber range.
export function deletedSprite(baseSize: number): THREE.Object3D {
  const group = new THREE.Group();
  const ring = new THREE.Sprite(ringMaterial('deleted'));
  const ringScale = baseSize * 1.6 * 0.7;
  ring.scale.set(ringScale, ringScale, 1);
  ring.renderOrder = 11;

  const disc = new THREE.Sprite(ghostMaterial());
  // Smaller than a normal file node so deleted files read at a glance.
  const discScale = baseSize * 0.6;
  disc.scale.set(discScale, discScale, 1);
  disc.renderOrder = 12;

  group.add(ring);
  group.add(disc);
  return group;
}
