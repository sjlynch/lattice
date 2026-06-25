import type { ForceGraph3DInstance } from '3d-force-graph';
import { locLabelRegistry } from '../locOverlay';
import { clearNameLabelRegistry } from '../labelsOverlay';
import { healthLabelRegistry } from '../healthOverlay';
import { clearMetricLabelRegistry } from '../metricOverlayFactory';
import { getIdleController } from '../idleController';

// Empty all three overlay label registries, releasing each sprite's cached
// label-texture reference (refcount-aware eviction) AND disposing each entry's
// cloned connector geometry as it goes. This is the ONE place the blanket
// teardown is expressed — every full-rebuild path (refresh, structural data
// swap, init teardown) routes through it so a registry is never `.clear()`'d
// without (a) balancing the texture refcounts — a bare clear would leak phantom
// references and stop the caches from ever reclaiming freed textures — and (b)
// freeing the per-line connector geometry the library leaves orphaned when
// `graph.refresh()` replaces the node objects (a bare clear leaks one GPU buffer
// per file node per refresh).
export function clearAllLabelRegistries(): void {
  clearMetricLabelRegistry(locLabelRegistry);
  clearMetricLabelRegistry(healthLabelRegistry);
  clearNameLabelRegistry();
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
  // The release-aware clear drops each detached sprite's label-texture refcount
  // AND disposes each entry's cloned connector geometry (a bare Set.clear()
  // leaks one BufferGeometry GPU buffer per file node every refresh, since the
  // refresh() below replaces the node objects without disposing them).
  clearAllLabelRegistries();
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
