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
import { spriteFor } from './sprites';
import { isGhost, readRelForward } from './timelineDiff';

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
  const baseSize = node.kind === 'dir' ? s.dirNodeSize : s.fileNodeSize;
  const root = new THREE.Group();
  root.userData['lattice:nodeRoot'] = true;

  // Ghost nodes (deleted files surfaced from git history) only exist in
  // the graph because the scrubber range picks up a delete event
  // somewhere — render them as a small grey disc with a red ring
  // instead of running spriteFor on a path that has no real file behind
  // it.
  if (isGhost(node)) {
    root.add(deletedSprite(s.fileNodeSize));
    if (refs.selectedRef.current.has(node.id)) {
      setNodeHalo(root, true, s.fileNodeSize);
    }
    return root;
  }

  // For the LOC and health overlays, fall back to the plain sprite when
  // the file's extension is on the per-project ignore list — e.g.
  // config/prose files by default. Directories aren't measured by either
  // overlay anyway, so the check is file-only.
  // `node.ext` is always lowercase at the source (the scanner lowercases it,
  // ghosts too) and the ignore Set is built from lowercased exts — so compare
  // directly and skip the per-node `.toLowerCase()` allocation that ran for
  // every file on every refresh.
  const ignored =
    node.kind === 'file' &&
    !!node.ext &&
    refs.metricsIgnoredExtsRef.current.has(node.ext);

  let base: THREE.Object3D;
  if (refs.healthModeRef.current && !ignored) {
    base = spriteForHealth(node, s);
  } else if (refs.locModeRef.current && !ignored) {
    base = spriteForLoc(node, s);
  } else if (refs.deadModeRef.current) {
    // Not gated on `ignored`: dead-code is about reachability, not metrics, so
    // every file gets the green/red/grey treatment (config/prose files just
    // resolve to neutral "uncertain" rather than falling back to ext color).
    base = spriteForDeadCode(node, s);
  } else {
    base = spriteFor(node, s);
  }

  root.add(base);

  // Change ring + selection halo both hang off the root as sibling children
  // (drawn behind / around the base via renderOrder + size, not by child
  // order). Adding the ring here keeps it correct through full rebuilds (data
  // swap, size/metric refresh); its interactive add/remove on a scrubber
  // change-set flip goes through `applyChangeRingDelta`, never `graph.refresh`.
  // The halo (1.8×) is larger than the change ring (1.6×) so a node that's
  // both changed and selected shows both rings concentrically.
  const rootData = refs.dataRef.current?.root || '';
  // `readRelForward` returns the value precomputed once per scan in
  // `buildForceGraphData` (falling back to a fresh compute for any node that
  // didn't come through it), so this no longer re-derives relForward on every
  // refresh. Only the changeMap lookup below is genuinely live (scrubbing the
  // timeline mutates the map).
  const rel = node.kind === 'file' ? readRelForward(node, rootData) : '';
  const kind = rel ? refs.changeMapRef.current.get(rel) : undefined;
  if (kind && kind !== 'deleted') {
    setNodeChangeRing(root, kind, baseSize);
  }

  // Name labels (Alt overlay) hang off the root as sibling children so the
  // active depth band / Shift gate can be toggled in place by the delta walker
  // without a global sprite rebuild — see `applyNodeLabelState`. Building it
  // here too keeps labels correct through full rebuilds (data swap, size/metric
  // refresh) that happen while Alt is held. Suppressed while a recolor overlay
  // (health / loc / dead) owns the sprite, matching the overlay precedence.
  if (
    refs.labelModeRef.current &&
    !refs.healthModeRef.current &&
    !refs.locModeRef.current &&
    !refs.deadModeRef.current
  ) {
    const d = refs.nodeDepthsRef.current.get(node.id) ?? 0;
    applyNodeLabelState(
      root,
      node,
      s,
      refs.labelLevelRef.current,
      d,
      refs.labelShiftRef.current,
      // With an active selection, the Alt overlay shows only the selected
      // nodes' labels — keep that true through full sprite rebuilds too.
      refs.selectedRef.current,
    );
  }

  if (refs.selectedRef.current.has(node.id)) {
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
