import { useEffect, useRef } from 'react';
import type { GraphSettings } from '../graphSettings';
import { clearLabelsAndRefresh } from './refresh';
import { type GraphRef, hasMountedNodes } from './graphSettingsEffectUtils';

export const SPRITE_REFRESH_DEBOUNCE_MS = 120;

type SpriteRefreshSettings = Pick<
  GraphSettings,
  'fileNodeSize' | 'dirNodeSize' | 'labelSize' | 'metricLabels' | 'showSubagentLabels'
>;

export function useSpriteAndMetricLabelRefresh(
  settings: SpriteRefreshSettings,
  graphRef: GraphRef,
): void {
  // Re-render sprites when render-only sprite settings (node/label sizes, and
  // whether the LOC/health metric labels are shown) change. Toggling the
  // subagent-label option also routes through here: it has no sprite effect of
  // its own, but the refresh wakes the render loop so the Agent Presence Layer's
  // frame handler applies the change at once (it reads the setting live each
  // tick) even when the scene was otherwise settled.
  //
  // The refresh rebuilds every node sprite, and the size sliders fire a settings
  // change per pointer move — so it is trailing-debounced: a drag costs one
  // rebuild when it settles, not one per pixel. A toggle (metric / subagent
  // labels) pays the same short delay, which is imperceptible.
  const appliedSizesRef = useRef<SpriteRefreshSettings>(settings);
  useEffect(() => {
    const prev = appliedSizesRef.current;
    const changed =
      prev.fileNodeSize !== settings.fileNodeSize ||
      prev.dirNodeSize !== settings.dirNodeSize ||
      prev.labelSize !== settings.labelSize ||
      prev.metricLabels !== settings.metricLabels ||
      prev.showSubagentLabels !== settings.showSubagentLabels;
    appliedSizesRef.current = settings;
    if (!changed) return;
    const timer = setTimeout(() => {
      const g = graphRef.current;
      if (!g || !hasMountedNodes(g)) return;
      clearLabelsAndRefresh(g);
    }, SPRITE_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    settings.fileNodeSize,
    settings.dirNodeSize,
    settings.labelSize,
    settings.metricLabels,
    settings.showSubagentLabels,
    graphRef,
  ]);
}
