import type { MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import { useDeadCodeOverlay } from './useDeadCodeOverlay';
import { useGitTimeline } from './useGitTimeline';
import { useGraphFilter } from './useGraphFilter';
import { useGraphSettings } from './useGraphSettings';
import { useHealthOverlay } from './useHealthOverlay';
import { useLabelsOverlay } from './useLabelsOverlay';
import { useLocOverlay } from './useLocOverlay';
import { useOverlayPins } from './useOverlayPins';

type UseGraphOverlaysArgs = {
  activeFolder: string;
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  data: ScanResult | null;
  hiddenExts: Set<string>;
  healthMode: boolean;
  onHealthModeChange: (mode: boolean) => void;
  // Current node selection — narrows the Alt label overlay to just these nodes.
  selected: Set<string>;
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
  selected,
}: UseGraphOverlaysArgs) {
  const { settings, setSettings, settingsRef } = useGraphSettings(
    activeFolder,
    graphRef,
  );

  const { history, range, setRange, changeMapRef } = useGitTimeline(
    activeFolder,
    graphRef,
    settingsRef,
    data,
  );

  // Pin state for the hold-key overlays — a pin latches a view on without
  // holding its key (the GraphOverlayKey chips toggle these; each overlay folds
  // its pin into the effective `held || pinned` mode). The `worktree` pin is
  // applied by ForceGraphView, which owns the worktree-highlight hook.
  const { pinned, togglePin } = useOverlayPins();

  const { locMode, locModeRef } = useLocOverlay(
    graphRef,
    settingsRef,
    pinned.loc,
  );
  const { healthModeRef } = useHealthOverlay(
    healthMode,
    onHealthModeChange,
    graphRef,
    settingsRef,
    pinned.health,
  );
  const { deadMode, deadModeRef } = useDeadCodeOverlay(graphRef, pinned.dead);
  const labels = useLabelsOverlay(
    graphRef,
    containerRef,
    data,
    settingsRef,
    selected,
    pinned.labels,
  );

  useGraphFilter(graphRef, hiddenExts, changeMapRef);

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
    deadMode,
    deadModeRef,
    pinned,
    togglePin,
    ...labels,
  };
}
