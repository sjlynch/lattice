import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import type { GraphNode, ScanResult } from '../../api';
import { deletedSprite, setNodeChangeRing, type ChangeKind } from './changeRing';
import { spriteForDeadCode } from './deadCodeOverlay';
import type { GraphSettings } from './graphSettings';
import { setNodeHalo } from './halo';
import { spriteForHealth } from './healthOverlay';
import { applyNodeLabelState } from './labelsOverlay';
import { spriteForLoc } from './locOverlay';
import { baseSizeFor } from './mountedNodes';
import { decideSpriteState } from './spriteDecision';
import { spriteFor } from './sprites';
import { isGhost } from './timelineDiff';

// Refs the node-object factory reads to pick the right sprite for the
// current overlay/selection state without forcing the parent hook to
// re-mount the graph when any of those values change.
export type NodeObjectRefs = {
  settingsRef: MutableRefObject<GraphSettings>;
  selectedRef: MutableRefObject<Set<string>>;
  dataRef: MutableRefObject<ScanResult | null>;
  locModeRef: MutableRefObject<boolean>;
  healthModeRef: MutableRefObject<boolean>;
  deadModeRef: MutableRefObject<boolean>;
  labelModeRef: MutableRefObject<boolean>;
  // Whether Shift is also held — gates file-node labels. Alt alone shows
  // only directory names.
  labelShiftRef: MutableRefObject<boolean>;
  labelLevelRef: MutableRefObject<number>;
  nodeDepthsRef: MutableRefObject<Map<string, number>>;
  changeMapRef: MutableRefObject<Map<string, ChangeKind>>;
  // Extensions (lowercased, leading-dot) that the LOC and code-health
  // overlays should skip — matching files render as their normal sprite
  // instead of a tinted shape with a numeric label.
  metricsIgnoredExtsRef: MutableRefObject<Set<string>>;
  // When true, the plain base shape is drawn by the shared InstancedMesh
  // (`instancedNodes.ts`); the per-node base sprite is kept but made invisible
  // so it still serves as the raycast/hover pick proxy and so the halo/ring/
  // label sibling children still anchor to it. Only the *base* (non-overlay,
  // non-ghost) sprite is hidden — recolor overlays keep their visible sprite
  // (the instanced mesh hides itself instead).
  batchedNodesRef: MutableRefObject<boolean>;
};

// Picks the THREE.Object3D that represents a node in the current frame.
// The overlay/selection decision tree lives here so the initialization
// hook reads like lifecycle wiring; sprite materials themselves are
// cached inside the individual overlay modules.
//
// The return value is **always a `THREE.Group`** acting as a stable
// per-node "root". The base composite (sprite / overlay group / ghost)
// is child[0]; the halo, when selected, is a sibling child added by
// `setNodeHalo`. Keeping this shape uniform lets the selection-change
// handler add/remove halos without calling `graph.refresh()` — see
// `useSelectionHaloSync`.
export function buildNodeObject(node: GraphNode, refs: NodeObjectRefs): THREE.Object3D {
  const s = refs.settingsRef.current;
  // Shared ghost-aware sizing — keeps the halo/ring scale added here in lock-step
  // with the selection/worktree delta walkers (see `mountedNodes`).
  const baseSize = baseSizeFor(node, s);
  const root = new THREE.Group();
  root.userData['lattice:nodeRoot'] = true;

  // Pure decision pass: all overlay/selection precedence lives in
  // `decideSpriteState` (which sprite, whether to hide it when batched, whether
  // to attach ring/halo/label). This function just applies the result as a
  // linear sequence of scene mutations.
  const d = decideSpriteState(node, refs);

  // Ghost nodes (deleted files surfaced from git history) only exist in
  // the graph because the scrubber range picks up a delete event
  // somewhere — render them as a small grey disc with a red ring
  // instead of running spriteFor on a path that has no real file behind
  // it.
  if (d.baseKind === 'ghost') {
    root.add(deletedSprite(s.fileNodeSize));
    if (d.selected) {
      setNodeHalo(root, true, s.fileNodeSize);
    }
    return root;
  }

  // Recolor precedence (health > loc > dead > base) was resolved into
  // `d.baseKind`; build the matching sprite. The overlay materials themselves
  // are cached inside the individual overlay modules.
  let base: THREE.Object3D;
  switch (d.baseKind) {
    case 'health':
      base = spriteForHealth(node, s);
      break;
    case 'loc':
      base = spriteForLoc(node, s);
      break;
    case 'dead':
      base = spriteForDeadCode(node, s);
      break;
    default:
      base = spriteFor(node, s);
  }

  root.add(base);

  // Batched-node rendering: the InstancedMesh draws the plain base shape, so
  // hide the per-node base sprite (it stays raycastable → still the hover/click
  // pick proxy; its halo/ring/label siblings stay visible). Only in the base
  // view — when a recolor overlay (health/loc/dead) owns the sprite, the
  // instanced mesh hides itself instead, so the overlay sprite must stay shown.
  if (d.hideBase) {
    base.visible = false;
  }

  // Change ring + selection halo both hang off the root as sibling children
  // (drawn behind / around the base via renderOrder + size, not by child
  // order). Adding the ring here keeps it correct through full rebuilds (data
  // swap, size/metric refresh); its interactive add/remove on a scrubber
  // change-set flip goes through `applyChangeRingDelta`, never `graph.refresh`.
  // The halo (1.8×) is larger than the change ring (1.6×) so a node that's
  // both changed and selected shows both rings concentrically.
  if (d.changeRingKind) {
    setNodeChangeRing(root, d.changeRingKind, baseSize);
  }

  // Name labels (Alt overlay) hang off the root as sibling children so the
  // active depth band / Shift gate can be toggled in place by the delta walker
  // without a global sprite rebuild — see `applyNodeLabelState`. Building it
  // here too keeps labels correct through full rebuilds (data swap, size/metric
  // refresh) that happen while Alt is held.
  if (d.showLabel) {
    applyNodeLabelState(
      root,
      node,
      s,
      refs.labelLevelRef.current,
      d.labelDepth,
      refs.labelShiftRef.current,
      // With an active selection, the Alt overlay shows only the selected
      // nodes' labels — keep that true through full sprite rebuilds too.
      refs.selectedRef.current,
    );
  }

  if (d.selected) {
    setNodeHalo(root, true, baseSize);
  }
  return root;
}

// Native 3d-force-graph hover label. Files always defer to HealthTooltip
// (rendered separately in React), so suppress the library label there to
// avoid stacking two tooltips; directories keep the simple folder hint.
export function nativeNodeLabel(node: GraphNode): string {
  // Deleted files surface as small grey "ghost" discs with a red ring. They
  // have no real file behind them, so HealthTooltip renders nothing for them —
  // which used to leave hover showing nothing at all. Use the library's native
  // hover label to still identify the removed file by its relative path.
  // (Ghosts are intentionally excluded from the Alt name-label overlay — see
  // `shouldShowLabel` in labelsOverlay — but hover should still name them.)
  if (isGhost(node)) return `🗑 ${node.path} (deleted)`;
  if (node.kind === 'file') return '';
  return `📁 ${node.name}`;
}
