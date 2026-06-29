import { useCallback, useMemo, useState } from 'react';
import type { TaskSpawnedEvent } from '../../../api';
import { LANES } from '../lanes';
import { sortTasksForLane } from '../laneSort';
import { useLaneSort } from './useLaneSort';
import { useTaskBoardState } from './useTaskBoardState';
import { useTaskSearch } from './useTaskSearch';
import { useVisibleLanes } from './useVisibleLanes';

// Data/view state for the board: task sync, lane visibility, filtering/search,
// selected cards, drag affordances, and display-order sorting. It intentionally
// does not start runs or mutate task details; those concerns are composed by
// useTaskBoardController alongside this view model.
export function useTaskBoardDataView(
  activeFolder: string,
  onTaskSpawned?: (event: TaskSpawnedEvent) => void,
) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const handleDragEnd = useCallback(() => setDraggingId(null), []);
  const { visibleLanes, toggleLane } = useVisibleLanes();

  const boardState = useTaskBoardState(activeFolder, onTaskSpawned);
  const {
    tasks,
    grouped,
    activeCount,
    error,
    setError,
    showError,
    selectedIds,
    clearSelection,
    toggleSelect,
    rangeSelect,
  } = boardState;

  // Per-lane clock/caret sort. Defaults to newest-arrival-first; dropping a
  // card at an explicit slot switches that lane to 'manual' so the user's
  // hand-ordering survives until they click the clock to re-sort.
  const { getMode: getLaneSortMode, toggle: toggleLaneSort, setManual } =
    useLaneSort(activeFolder);

  const {
    taskSearch,
    setTaskSearch,
    searchActive,
    filteredTasks,
    filteredGrouped,
  } = useTaskSearch(tasks);

  const sortedGrouped = useMemo(() => {
    const out = {} as typeof filteredGrouped;
    for (const lane of LANES) {
      out[lane.id] = sortTasksForLane(
        filteredGrouped[lane.id],
        lane.id,
        getLaneSortMode(lane.id),
      );
    }
    return out;
  }, [filteredGrouped, getLaneSortMode]);

  return {
    activeCount,
    clearSelection,
    draggingId,
    error,
    filteredGrouped,
    filteredTasks,
    getLaneSortMode,
    grouped,
    handleDragEnd,
    rangeSelect,
    searchActive,
    selectedIds,
    setDraggingId,
    setError,
    setManual,
    setTaskSearch,
    showError,
    sortedGrouped,
    taskSearch,
    tasks,
    toggleLane,
    toggleLaneSort,
    toggleSelect,
    visibleLanes,
  };
}
