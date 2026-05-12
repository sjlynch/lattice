import type { MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import { useGitTimeline } from './useGitTimeline';
import { useGraphFilter } from './useGraphFilter';
import { useGraphSettings } from './useGraphSettings';
import { useHealthOverlay } from './useHealthOverlay';
import { useLabelsOverlay } from './useLabelsOverlay';
import { useLocOverlay } from './useLocOverlay';

type UseGraphOverlaysArgs = {
  activeFolder: string;
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  data: ScanResult | null;
  hiddenExts: Set<string>;
  healthMode: boolean;
  onHealthModeChange: (mode: boolean) => void;
};

// Coordinates the graph's overlay concerns: persisted graph settings, git
// timeline filtering, and the transient LOC/health/name-label modes. The
// individual hooks remain focused; ForceGraphView gets one clearly named setup
// point instead of a long grid of unrelated overlay calls.
export function useGraphOverlays({
  activeFolder,
  graphRef,
  containerRef,
  data,
  hiddenExts,
  healthMode,
  onHealthModeChange,
}: UseGraphOverlaysArgs) {
  const { settings, setSettings, settingsRef } = useGraphSettings(
    activeFolder,
    graphRef,
  );

  const { history, range, setRange, changeMapRef } = useGitTimeline(
    activeFolder,
    graphRef,
  );

  const { locMode, locModeRef } = useLocOverlay(graphRef, settingsRef);
  const { healthModeRef } = useHealthOverlay(
    healthMode,
    onHealthModeChange,
    graphRef,
    settingsRef,
  );
  const labels = useLabelsOverlay(graphRef, containerRef, data, settingsRef);

  useGraphFilter(graphRef, hiddenExts, data, history, range, changeMapRef);

  return {
    settings,
    setSettings,
    settingsRef,
    history,
    range,
    setRange,
    changeMapRef,
    locMode,
    locModeRef,
    healthModeRef,
    ...labels,
  };
}
