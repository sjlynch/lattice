import type { ForceGraph3DInstance } from '3d-force-graph';
import { locLabelRegistry } from '../locOverlay';
import { labelsRegistry } from '../labelsOverlay';
import { healthLabelRegistry } from '../healthOverlay';
import { getIdleController } from '../idleController';
import { wakeAllRepulsion } from '../labelRepulsionWake';

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
  locLabelRegistry.clear();
  labelsRegistry.clear();
  healthLabelRegistry.clear();
  graph?.refresh?.();
  if (graph) {
    graph.enablePointerInteraction(false);
    graph.enablePointerInteraction(true);
  }
  getIdleController(graph)?.wakeForRefresh();
  // The repulsion RAF stops itself once labels settle. A refresh()
  // tears down those label sprites (the registries above were just
  // cleared) and `buildNodeObject` re-registers fresh ones at their
  // home position — those need the RAF to run again to repel apart.
  wakeAllRepulsion();
}

export function isTextInput(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}
