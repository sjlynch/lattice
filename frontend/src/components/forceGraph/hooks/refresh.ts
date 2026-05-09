import type { ForceGraph3DInstance } from '3d-force-graph';
import { locLabelRegistry } from '../locOverlay';
import { labelsRegistry } from '../labelsOverlay';
import { healthLabelRegistry } from '../healthOverlay';

// Sprites cached by spriteFor are reused; refresh() just re-runs
// nodeThreeObject. Any overlay swap orphans previously-registered
// labels because their backing Sprites get replaced, so we always
// clear all three registries before refreshing.
export function clearLabelsAndRefresh(graph: ForceGraph3DInstance | null) {
  locLabelRegistry.clear();
  labelsRegistry.clear();
  healthLabelRegistry.clear();
  graph?.refresh?.();
}

export function isTextInput(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}
