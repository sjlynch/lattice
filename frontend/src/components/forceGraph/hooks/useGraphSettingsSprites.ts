import { useEffect, useRef } from 'react';
import type { GraphSettings } from '../graphSettings';
import { clearLabelsAndRefresh } from './refresh';
import { type GraphRef, hasMountedNodes } from './graphSettingsEffectUtils';

type SpriteRefreshSettings = Pick<
  GraphSettings,
  'fileNodeSize' | 'dirNodeSize' | 'labelSize' | 'metricLabels'
>;

export function useSpriteAndMetricLabelRefresh(
  settings: SpriteRefreshSettings,
  graphRef: GraphRef,
): void {
  // Re-render sprites when render-only sprite settings (node/label sizes, and
  // whether the LOC/health metric labels are shown) change.
  const appliedSizesRef = useRef<SpriteRefreshSettings>(settings);
  useEffect(() => {
    const prev = appliedSizesRef.current;
    const changed =
      prev.fileNodeSize !== settings.fileNodeSize ||
      prev.dirNodeSize !== settings.dirNodeSize ||
      prev.labelSize !== settings.labelSize ||
      prev.metricLabels !== settings.metricLabels;
    appliedSizesRef.current = settings;
    const g = graphRef.current;
    if (!changed || !g || !hasMountedNodes(g)) return;
    clearLabelsAndRefresh(g);
  }, [
    settings.fileNodeSize,
    settings.dirNodeSize,
    settings.labelSize,
    settings.metricLabels,
    graphRef,
  ]);
}
