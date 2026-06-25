// Change-rings overlay for the timeline scrubber. A colored ring sprite
// (added=green, modified=yellow) is toggled as a *sibling child* of a
// node's root Group — the same in-place pattern as the selection halo
// (`halo.ts`) and worktree ring (`worktreeRing.ts`). For the deleted case a
// node has no real file behind it, so it's rendered from scratch as a smaller
// grey "ghost" disc + red ring (`deletedSprite`).
//
// Drawing the ring as a sibling toggle (rather than wrapping the base sprite
// in a child group) is what lets `changeRingSync.applyChangeRingDelta` add /
// remove / recolor rings on only the nodes whose ChangeKind actually flipped
// when the scrubber moves, instead of rebuilding every node's THREE object.
//
// This module is a thin facade over the texture/material split:
//   - changeRingTextures.ts — canvas-texture builders + named constants
//   - changeRingMaterials.ts — cached SpriteMaterials (3 rings + 1 ghost)
// so a graph with thousands of changed nodes still allocates exactly four
// GPU resources. Public API (setNodeChangeRing, deletedSprite,
// setNodeChangeRingsVisible, setChangeRingsSuppressed, ChangeKind) lives here.

import * as THREE from 'three';
import { ringMaterial, ghostMaterial } from './changeRingMaterials';
import type { ChangeKind } from './changeRingTextures';
import { RING_RENDER_ORDER, NODE_RENDER_ORDER } from './renderOrders';

export type { ChangeKind } from './changeRingTextures';

// Tag set on every timeline change-ring sprite so the `W` worktree overlay
// can momentarily hide them (the two ring styles are hard to tell apart
// when stacked, so worktree view suppresses change rings while held) and so
// `setNodeChangeRing` can locate an existing ring without scanning by type.
const CHANGE_RING_TAG = 'lattice:changeRing';
// Records the ChangeKind currently drawn so a delta can detect a recolor
// (e.g. added → modified) and swap the cached material in place.
const CHANGE_RING_KIND = 'lattice:changeRing:kind';

// While the `W` worktree overlay is active it suppresses the git change-rings
// (the two ring styles stack confusingly). `setNodeChangeRingsVisible` only
// hides the rings mounted at the instant W activated — but a later full rebuild
// (`buildNodeObject` → `setNodeChangeRing`) or scrub-delta add
// (`applyChangeRingDelta` → `setNodeChangeRing`) mints *fresh* ring sprites,
// which would default to visible and reappear, defeating the suppression. This
// flag makes every newly-built ring start hidden while W is active; because all
// ring creation funnels through `buildChangeRingSprite`, both paths are covered
// at the single chokepoint. The W overlay flips it on activate/deactivate
// (see `useWorktreeHighlight`).
let changeRingsSuppressed = false;

// Set the default visibility for change rings minted from now on. `true` while
// the `W` worktree overlay is active so refreshes/scrubs can't surface a fresh
// (visible) ring; `false` restores normal visibility. Pairs with
// `setNodeChangeRingsVisible`, which handles the already-mounted rings.
export function setChangeRingsSuppressed(suppressed: boolean): void {
  changeRingsSuppressed = suppressed;
}

// Hide / show all timeline change-ring sprites under a node's root Group.
// Traverses descendants so it still finds the ring whether it sits as a
// direct child of the root (real file nodes — see `setNodeChangeRing`) or
// nested inside the ghost composite (`deletedSprite`'s ring is untagged, so
// only the former is affected; the ghost disc/ring are left alone).
export function setNodeChangeRingsVisible(
  root: THREE.Object3D,
  visible: boolean,
): void {
  root.traverse((obj) => {
    if (obj.userData[CHANGE_RING_TAG]) obj.visible = visible;
  });
}

function findChangeRingChild(root: THREE.Object3D): THREE.Sprite | null {
  // child counts are tiny (root + base + optional change ring / halo / label);
  // a direct scan beats keeping a side map and the userData check is O(1).
  for (const child of root.children) {
    if (child.userData[CHANGE_RING_TAG]) return child as THREE.Sprite;
  }
  return null;
}

function buildChangeRingSprite(baseSize: number, kind: ChangeKind): THREE.Sprite {
  const ring = new THREE.Sprite(ringMaterial(kind));
  // Ring slightly larger than the node so it reads as an outline, not an
  // overlay. The selection halo (1.8×) is larger still so both read
  // concentrically when a changed node is also selected.
  const s = baseSize * 1.6;
  ring.scale.set(s, s, 1);
  // Sit at RING_RENDER_ORDER — below the base node body (NODE_RENDER_ORDER) so
  // the body paints over the inner part of the disc, leaving only the colored
  // outline showing. Every node sprite runs `depthTest:false`, so renderOrder is
  // the sole arbiter of paint order regardless of parent, which keeps the ring
  // behind the base now that it's a sibling of the root rather than a wrapping
  // child group.
  ring.renderOrder = RING_RENDER_ORDER;
  ring.userData[CHANGE_RING_TAG] = true;
  ring.userData[CHANGE_RING_KIND] = kind;
  // Start hidden while the `W` overlay is suppressing change rings, so a rebuild
  // or scrub that mints a fresh ring doesn't reappear over the worktree rings.
  ring.visible = !changeRingsSuppressed;
  return ring;
}

// Toggle (or recolor) a timeline change ring on a node's root Group. `kind`
// null removes the ring; a different kind swaps the cached material in place.
// Idempotent: a no-op when the requested state already matches. Called from
// `buildNodeObject` (full rebuild) and `applyChangeRingDelta` (scrub delta).
export function setNodeChangeRing(
  root: THREE.Object3D,
  kind: ChangeKind | null,
  baseSize: number,
): void {
  const existing = findChangeRingChild(root);
  if (!kind) {
    if (existing) root.remove(existing);
    return;
  }
  if (existing) {
    // Already ringed — just make sure it shows the right kind's color.
    if (existing.userData[CHANGE_RING_KIND] !== kind) {
      existing.material = ringMaterial(kind);
      existing.userData[CHANGE_RING_KIND] = kind;
    }
    return;
  }
  root.add(buildChangeRingSprite(baseSize, kind));
}

// Render a "deleted" node from scratch: small grey disc + red ring.
// Used for files that no longer exist in the working tree but were
// alive at some point inside the scrubber range.
export function deletedSprite(baseSize: number): THREE.Object3D {
  const group = new THREE.Group();
  const ring = new THREE.Sprite(ringMaterial('deleted'));
  const ringScale = baseSize * 1.6 * 0.7;
  ring.scale.set(ringScale, ringScale, 1);
  ring.renderOrder = RING_RENDER_ORDER;

  const disc = new THREE.Sprite(ghostMaterial());
  // Smaller than a normal file node so deleted files read at a glance.
  const discScale = baseSize * 0.6;
  disc.scale.set(discScale, discScale, 1);
  disc.renderOrder = NODE_RENDER_ORDER;

  group.add(ring);
  group.add(disc);
  return group;
}
