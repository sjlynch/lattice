import { useCallback, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import type { GraphSettings } from '../graphSettings';
import { useBoxSelect } from './useBoxSelect';
import { useGraphSearchController } from './useGraphSearchController';
import { useGraphTaskCreation } from './useGraphTaskCreation';
import { useGraphViewKeyboard } from './useGraphViewKeyboard';
import { useMetricsIgnoreRefresh } from './useMetricsIgnoreRefresh';
import { useNodeContextMenu } from './useNodeContextMenu';
import { useOverlayTooltipDismiss } from './useOverlayTooltipDismiss';
import { useSelectionGlowSettings } from './useSelectionGlowSettings';
import { useSelectionHaloPulse } from './useSelectionHaloPulse';
import { useSelectionHaloSync } from './useSelectionHaloSync';

type Args = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  activeFolder: string;
  data: ScanResult | null;
  // Bumped by useGraphDataSync on every full graphData() swap.
  dataGeneration: number;
  settings: GraphSettings;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  // Live mirrors the coordinator owns, passed through (never copied).
  selectedRef: MutableRefObject<Set<string>>;
  hiddenExtsRef: MutableRefObject<Set<string>>;
  metricsIgnoredExtsSet: Set<string>;
  locMode: boolean;
  healthMode: boolean;
  // Clears the hover tooltip (useHoverNodeDebounce's cancelPendingHoverClear).
  cancelPendingHoverClear: () => void;
};

// The graph's user-interaction layer, extracted from the coordinator: search
// (query, toggles, match cursor), the right-click context menu, shift-drag box
// select, the create-task modal + toast, selection halo sync/pulse/glow, the
// metrics-ignore sprite refresh, the Escape chord, and the overlay-end tooltip
// dismiss. Runs after useGraphSceneRuntime in the coordinator's original hook
// order. Returns the search / task-modal props already shaped for
// useGraphViewChromeModel.
export function useGraphInteraction({
  containerRef,
  graphRef,
  activeFolder,
  data,
  dataGeneration,
  settings,
  selected,
  setSelected,
  selectedRef,
  hiddenExtsRef,
  metricsIgnoredExtsSet,
  locMode,
  healthMode,
  cancelPendingHoverClear,
}: Args) {
  // Search: query + regex/contents toggle state, the filename/contents passes,
  // and the prev/next match cursor are all wired together in the controller. It
  // returns the HUD-ready handlers/status/position plus the
  // `searchQuery`/`setSearchQuery`/`clearCurrentMatch` the Escape chord needs.
  const {
    searchQuery,
    setSearchQuery,
    searchRegex,
    searchContents,
    toggleSearchRegex,
    toggleSearchContents,
    handleSearchQueryChange,
    searchStatus,
    searchMatchPosition,
    goPrevMatch,
    goNextMatch,
    clearCurrentMatch,
  } = useGraphSearchController({ data, activeFolder, graphRef, setSelected, dataGeneration });

  const { contextMenu, setContextMenu } = useNodeContextMenu(containerRef);
  const closeContextMenu = useCallback(() => setContextMenu(null), [setContextMenu]);
  const { dragRect } = useBoxSelect(
    containerRef,
    graphRef,
    hiddenExtsRef,
    setSelected,
    closeContextMenu,
  );

  const {
    modalAction,
    promptText,
    setPromptText,
    submitting,
    toast,
    selectedFiles,
    openMenuItem,
    submitTask,
    closeModal,
  } = useGraphTaskCreation({
    data,
    activeFolder,
    selected,
    setSelected,
    closeContextMenu,
  });

  // Targeted halo updates — toggle the halo Sprite on only the affected node
  // ids instead of a full `graph.refresh()` (see the hook). Runtime scene sync.
  useSelectionHaloSync(graphRef, selected, settings);
  // Pulse the shared halo material (brighter/whiter ⇄ base) while any node is
  // selected so selection rings stay visible in dense graphs. O(1) per frame;
  // holds the idle controller's slow-only `halo` reason only while selected.
  useSelectionHaloPulse(graphRef, selected.size > 0);
  // Push the Rendering-tab glow knobs (strength/size) into the halo module and
  // apply changes to the current selection (strength live, size rebuilds halos).
  useSelectionGlowSettings(settings, graphRef, selected);

  // Re-render node sprites when the LOC/health ignore list changes so the new
  // filter takes effect without touching the d3 simulation (skips the mount
  // run; see the hook).
  useMetricsIgnoreRefresh(graphRef, metricsIgnoredExtsSet);

  // Escape-key behavior (close context menu → clear search → clear selection),
  // bound once and reading its branch state through refs.
  useGraphViewKeyboard({
    contextMenu,
    setContextMenu,
    modalOpen: modalAction !== null,
    searchQuery,
    setSearchQuery,
    clearCurrentMatch,
    selectedRef,
    setSelected,
  });

  // Dismiss a stuck hover tooltip when the LOC/health overlay view ends, so it
  // doesn't cling to the cursor after Z/H is released (see the hook).
  useOverlayTooltipDismiss(locMode, healthMode, cancelPendingHoverClear);

  return {
    contextMenu,
    dragRect,
    openMenuItem,
    search: {
      searchQuery,
      onSearchQueryChange: handleSearchQueryChange,
      searchRegex,
      onSearchRegexToggle: toggleSearchRegex,
      searchContents,
      onSearchContentsToggle: toggleSearchContents,
      searchStatus,
      searchMatchPosition,
      onSearchPrevMatch: goPrevMatch,
      onSearchNextMatch: goNextMatch,
    },
    taskModal: {
      action: modalAction,
      promptText,
      onPromptChange: setPromptText,
      submitting,
      selectedFiles,
      onSubmit: submitTask,
      onClose: closeModal,
    },
    toast,
  };
}
