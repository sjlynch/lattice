import { useEffect, useRef } from 'react';
import type { GraphSettings } from '../graphSettings';
import { clearLabelsAndRefresh } from './refresh';
import { type GraphRef, hasMountedNodes } from './graphSettingsEffectUtils';

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
    const g = graphRef.current;
    if (!changed || !g || !hasMountedNodes(g)) return;
    clearLabelsAndRefresh(g);
  }, [
    settings.fileNodeSize,
    settings.dirNodeSize,
    settings.labelSize,
    settings.metricLabels,
    settings.showSubagentLabels,
    graphRef,
  ]);
}
