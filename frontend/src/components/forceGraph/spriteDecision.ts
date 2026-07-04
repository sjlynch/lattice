import type { GraphNode } from '../../api';
import type { ChangeKind } from './changeRing';
import type { NodeObjectRefs } from './nodeObjectFactory';
import { isGhost, readRelForward } from './timelineDiff';

// Which sprite the node's base composite is built from. Precedence for the
// recolor overlays is health > loc > dead > base; `ghost` short-circuits the
// whole tree (deleted-file disc + optional halo, nothing else).
export type SpriteBaseKind = 'ghost' | 'health' | 'loc' | 'dead' | 'base';

// A plain, THREE-free description of what a node's object should contain in the
// current overlay/selection frame. `decideSpriteState` computes it by reading
// the live refs; `buildNodeObject` then applies it as a flat sequence of
// mutations, so the branching precedence lives in one pure place.
export type SpriteDecision = {
  // Base sprite to build. `'ghost'` means: draw the deleted-file disc and stop.
  baseKind: SpriteBaseKind;
  // Hide the per-node base sprite because the shared InstancedMesh draws the
  // plain shape (batched rendering). Only ever true in the base view — recolor
  // overlays keep their visible sprite. Never set for ghosts.
  hideBase: boolean;
  // Change-ring kind to attach as a sibling child, or `null` for none. Already
  // gated on non-metric views and on being a live add/modify (never a delete).
  changeRingKind: ChangeKind | null;
  // Whether the Alt name-label sibling child should be attached.
  showLabel: boolean;
  // Depth band for the label (only meaningful when `showLabel` is true).
  labelDepth: number;
  // Whether the node is selected → attach the selection halo.
  selected: boolean;
};

// Pure decision tree for a node's sprite/overlay/selection state. Reads only
// the live refs (no THREE objects created, no scene mutated) so the
// ghost/health/loc/dead/base precedence, the batched-hide gate, and the
// ring/label/halo attach gates all read as one linear sequence here — and
// `buildNodeObject` becomes flat wiring that applies the result.
export function decideSpriteState(
  node: GraphNode,
  refs: NodeObjectRefs,
): SpriteDecision {
  const selected = refs.selectedRef.current.has(node.id);

  // Ghost nodes (deleted files surfaced from git history) render as a small
  // grey disc with a red ring — no overlay sprite, ring, or label — so the
  // rest of the decision tree is skipped entirely.
  if (isGhost(node)) {
    return {
      baseKind: 'ghost',
      hideBase: false,
      changeRingKind: null,
      showLabel: false,
      labelDepth: 0,
      selected,
    };
  }

  // For the LOC and health overlays, fall back to the plain sprite when the
  // file's extension is on the per-project ignore list — e.g. config/prose
  // files by default. Directories aren't measured by either overlay anyway, so
  // the check is file-only. `node.ext` is already lowercase at the source and
  // the ignore Set is built from lowercased exts, so compare directly and skip
  // the per-node `.toLowerCase()` allocation.
  const ignored =
    node.kind === 'file' &&
    !!node.ext &&
    refs.metricsIgnoredExtsRef.current.has(node.ext);

  let baseKind: SpriteBaseKind;
  if (refs.healthModeRef.current && !ignored) {
    baseKind = 'health';
  } else if (refs.locModeRef.current && !ignored) {
    baseKind = 'loc';
  } else if (refs.deadModeRef.current) {
    // Not gated on `ignored`: dead-code is about reachability, not metrics, so
    // every file gets the green/red/grey treatment (config/prose files just
    // resolve to neutral "uncertain" rather than falling back to ext color).
    baseKind = 'dead';
  } else {
    baseKind = 'base';
  }

  // True while any recolor view (health `h` / loc `z` / dead `d`) owns the
  // sprite. These views strip the graph down to just the metric signal, so the
  // batched-hide, change-ring, and label gates below all key off it.
  const metricOverlayActive =
    refs.healthModeRef.current ||
    refs.locModeRef.current ||
    refs.deadModeRef.current;

  // Batched-node rendering: the InstancedMesh draws the plain base shape, so
  // the per-node base sprite is hidden (it stays raycastable → still the
  // hover/click pick proxy; its halo/ring/label siblings stay visible). Only in
  // the base view — a recolor overlay owning the sprite hides the instanced
  // mesh instead, so the overlay sprite must stay shown.
  const hideBase = refs.batchedNodesRef.current && !metricOverlayActive;

  // Change ring: `readRelForward` returns the value precomputed once per scan
  // in `buildForceGraphData`; only the changeMap lookup is genuinely live
  // (scrubbing the timeline mutates the map). Suppressed while a metric view is
  // active — change-rings stack confusingly with the health/loc/dead coloring.
  const rootData = refs.dataRef.current?.root || '';
  const rel = node.kind === 'file' ? readRelForward(node, rootData) : '';
  const kind = rel ? refs.changeMapRef.current.get(rel) : undefined;
  const changeRingKind =
    !metricOverlayActive && kind && kind !== 'deleted' ? kind : null;

  // Name labels (Alt overlay) — suppressed while a recolor overlay owns the
  // sprite, matching the overlay precedence. Depth band is read here so the
  // caller stays flat.
  const showLabel = refs.labelModeRef.current && !metricOverlayActive;
  const labelDepth = showLabel
    ? refs.nodeDepthsRef.current.get(node.id) ?? 0
    : 0;

  return {
    baseKind,
    hideBase,
    changeRingKind,
    showLabel,
    labelDepth,
    selected,
  };
}
