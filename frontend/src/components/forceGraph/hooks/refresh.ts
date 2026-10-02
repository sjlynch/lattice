import type { ForceGraph3DInstance } from '3d-force-graph';
import { locLabelRegistry } from '../locOverlay';
import { clearNameLabelRegistry, trimNameLabelTextures } from '../labelsOverlay';
import { healthLabelRegistry } from '../healthOverlay';
import { clearMetricLabelRegistry, trimMetricLabelTextures } from '../metricOverlayFactory';
import { getIdleController } from '../idleController';

// How a blanket clear reclaims the label textures it releases:
// - 'teardown' (default): nothing rebuilds these labels (graph teardown). Evict
//   every free entry now: the name and metric caches are module-level and
//   outlive the graph, so free entries would otherwise sit there, canvases and
//   all, until the next graph happens to build labels.
// - 'batched': the caller is about to make the library rebuild the node objects
//   (`graph.refresh()` / `graph.graphData(...)`). Release refcounts without
//   evicting, so the rebuild re-acquires the textures of labels that are still
//   on screen instead of rasterizing them again, then trim once afterwards
//   (LABEL_TRIM_DELAY_MS).
export type LabelClearMode = 'batched' | 'teardown';

// When the one trim that ends a 'batched' clear runs. It must run after the
// library's digest has re-run `nodeThreeObject`, or it would evict free entries
// the rebuild is about to re-acquire. Neither `graph.refresh()` nor
// `graph.graphData()` rebuilds synchronously: each schedules kapsule's digest,
// a lodash `debounce(digest, 1)` (a trailing 1 ms setTimeout, re-armed for the
// remaining <= 1 ms if it fires early). Every 'batched' caller triggers that
// digest in the same synchronous run as this clear, so the digest's timer is
// due ~99 ms before this one. Browsers dispatch timers in due-time order, so
// the trim follows the digest even when a stalled main thread makes both
// overdue. The digest itself is synchronous, so the whole rebuild has finished.
// A later 'batched' clear reschedules the trim, so a pending trim never fires
// between a newer clear and its digest; clears that overlap share one trim.
export const LABEL_TRIM_DELAY_MS = 100;

let pendingLabelTrim: ReturnType<typeof setTimeout> | null = null;

function cancelLabelTrim(): void {
  if (pendingLabelTrim === null) return;
  clearTimeout(pendingLabelTrim);
  pendingLabelTrim = null;
}

function scheduleLabelTrim(): void {
  cancelLabelTrim();
  pendingLabelTrim = setTimeout(() => {
    pendingLabelTrim = null;
    trimMetricLabelTextures();
    trimNameLabelTextures();
  }, LABEL_TRIM_DELAY_MS);
}

// Empty all three overlay label registries, releasing each sprite's cached
// label-texture reference (refcount-aware eviction) AND disposing each entry's
// cloned connector geometry as it goes. This is the ONE place the blanket
// clear is expressed — every full-rebuild path (refresh, structural data swap,
// the `!data` reset, init teardown) routes through it so a registry is never
// `.clear()`'d without balancing the texture refcounts (a bare clear would leak
// phantom references and stop the caches from ever reclaiming freed textures).
// The library also deallocates the node objects it replaces (see
// clearLabelsAndRefresh), so the geometry dispose here is a harmless repeat.
// It is not the only release path: the repulsion loop releases single entries
// whose node root left the scene (`releaseNameLabelEntry` /
// `releaseMetricLabelEntry` as `repelLabels`' `onDetached`), and the Alt delta
// walker toggles single labels; those trim the caches immediately (or, while
// a batch is open, leave it to that batch's deferred trim).
export function clearAllLabelRegistries(mode: LabelClearMode = 'teardown'): void {
  // Teardown evicts every free entry itself; a pending trim would be a no-op.
  if (mode === 'teardown') cancelLabelTrim();
  // Each clear reports whether its cache now waits for the deferred trim (a
  // batch that left nothing free ends at once and needs none).
  const locPending = clearMetricLabelRegistry(locLabelRegistry, mode);
  const healthPending = clearMetricLabelRegistry(healthLabelRegistry, mode);
  const namesPending = clearNameLabelRegistry(mode);
  if (locPending || healthPending || namesPending) scheduleLabelTrim();
}

// Sprites cached by spriteFor are reused; refresh() just re-runs
// nodeThreeObject. Any overlay swap orphans previously-registered
// labels because their backing Sprites get replaced, so we always
// clear all three registries before refreshing. We also wake the idle
// controller so the next few frames paint the rebuilt sprites (the
// render loop is otherwise paused once the engine has settled).
//
// `enablePointerInteraction(false).enablePointerInteraction(true)` is a
// no-op for normal operation, but its onChange handler clears
// three-render-objects' cached `state.hoverObj` (which still points to
// the *old* sprite after `refresh()` replaces the THREE objects). Without
// this reset, the very first raycast after the rebuild can find the new
// group, see it as "the same hover target as before", and skip firing
// `onNodeHover` — which manifested as the health tooltip never appearing
// while `h` was held.
export function clearLabelsAndRefresh(graph: ForceGraph3DInstance | null) {
  // The refresh's digest replaces every node object, and three-forcegraph's
  // `onRemoveObj` → `_deallocate` disposes each replaced object recursively:
  // geometry (incl. the cloned connector), material, and `material.map` — the
  // cached label texture's GPU handle. A cached texture the rebuild re-acquires
  // is re-uploaded from its retained canvas, still no new canvas. So the clear
  // only has to balance the refcounts, batched so the still-visible labels
  // survive until the rebuild re-acquires them.
  clearAllLabelRegistries('batched');
  graph?.refresh?.();
  if (graph) {
    graph.enablePointerInteraction(false);
    graph.enablePointerInteraction(true);
  }
  getIdleController(graph)?.wakeForRefresh();
}

export function isTextInput(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}
