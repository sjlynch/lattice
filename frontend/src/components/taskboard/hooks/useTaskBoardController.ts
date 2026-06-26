import { useCallback, useMemo, useState } from 'react';
import { useTerminals } from '../../../TerminalsContext';
import { type TaskStatus } from '../../../api';
import { LANES } from '../lanes';
import { sortTasksForLane } from '../laneSort';
import { useMergeRunSync } from './useMergeRunSync';
import { usePostMergeHook } from './usePostMergeHook';
import { usePushRun } from './usePushRun';
import { useHarnessSelector } from './useHarnessSelector';
import { useQaPlaywright } from './useQaPlaywright';
import { useQaRuns } from './useQaRuns';
import { useLaneSort } from './useLaneSort';
import { useLaneBulkActions } from './useLaneBulkActions';
import { useTaskActions } from './useTaskActions';
import { useTaskBoardState } from './useTaskBoardState';
import { useTaskSearch } from './useTaskSearch';
import { useTaskSpawnHandler } from './useTaskSpawnHandler';
import { useTaskTerminals } from './useTaskTerminals';
import { useSyncedViewedTask } from './useSyncedViewedTask';
import { useVisibleLanes } from './useVisibleLanes';

// Central controller for the taskboard panel. It composes the task, merge,
// push, QA, post-merge, harness, lane-sort, search, selection, and terminal
// hooks into one shape so TaskBoardLauncher can stay focused on FloatingPanel
// chrome and JSX placement.
export function useTaskBoardController(activeFolder: string) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<TaskStatus | null>(null);

  // Stable so it doesn't defeat React.memo(TaskCard) on every re-render.
  const handleDragEnd = useCallback(() => setDraggingId(null), []);

  const { visibleLanes, toggleLane } = useVisibleLanes();

  const {
    addTerminal,
    closeTerminal,
    closeTerminals,
    closeTerminalsForTask,
    terminals,
    setActiveId,
  } = useTerminals();

  // `task-spawned` → mount the (queued) task's terminal + ping the resume strip.
  // `setBulkSpawnNotifier` bridges in the strip's notifier later (it's produced
  // after the task list, which needs `handleTaskSpawned`).
  const { handleTaskSpawned, setBulkSpawnNotifier } =
    useTaskSpawnHandler(addTerminal);

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
  } = useTaskBoardState(activeFolder, handleTaskSpawned);

  const { mergeRun, recentRunSummary, dismissRecent } = useMergeRunSync(
    activeFolder,
    addTerminal,
    showError,
  );
  const { activePush, startPush, hasGit } = usePushRun(
    activeFolder,
    addTerminal,
    closeTerminal,
    showError,
  );
  const { harness, piModel, piMenu, selectHarness, harnessAvail, pickRunHarness } =
    useHarnessSelector(activeFolder);
  const qaPlaywright = useQaPlaywright(activeFolder);
  const { startQaRun, startAllQaRuns } = useQaRuns(
    activeFolder,
    addTerminal,
    closeTerminal,
    showError,
  );
  const postMergeHook = usePostMergeHook(activeFolder, addTerminal, showError);

  // Per-lane clock/caret sort. Defaults to newest-arrival-first; dropping a
  // card at an explicit slot switches that lane to 'manual' so the user's
  // hand-ordering survives until they click the clock to re-sort. Read before
  // the action hooks: the reorder math splices into this same display order so
  // a dropped card lands at the slot the user saw (the 'manual' flip below is
  // queued, so getLaneSortMode still reports the pre-drop mode during the drop).
  const { getMode: getLaneSortMode, toggle: toggleLaneSort, setManual } =
    useLaneSort(activeFolder);

  const {
    addTask,
    moveTask,
    moveMulti,
    dropAtMulti,
    dropAt,
    editTask,
    deleteTask,
    runTask,
    runAllOpen,
    cancelQueuedRun,
    resumeTaskAction,
    resumeAllInProgress,
    mergeTaskAction,
    mergeAllReady,
    cancelActiveRun,
    clearStuckConflicts,
    markAllQaDone,
  } = useTaskActions({
    activeFolder,
    tasks,
    grouped,
    getLaneSortMode,
    mergeRun,
    addTerminal,
    clearSelection,
    pickRunHarness,
    showError,
  });

  // Live progress strips for the Open/In Progress/QA lane bulk actions
  // (mirrors the Ready-to-Merge MergeRunStrip), plus the per-lane "run all"
  // action map. Owns the strip state and bridges the resume notifier back to
  // the spawn handler via `setBulkSpawnNotifier`.
  const { runAllActionByLane, bulkStrips, dismissBulk } = useLaneBulkActions({
    tasks,
    setBulkSpawnNotifier,
    runAllOpen,
    resumeAllInProgress,
    mergeAllReady,
    markAllQaDone,
  });

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

  const handleDropAt = useCallback(
    (id: string, status: TaskStatus, index: number) => {
      setManual(status);
      dropAt(id, status, index);
    },
    [setManual, dropAt],
  );
  const handleMultiDropAt = useCallback(
    (ids: string[], status: TaskStatus, index: number) => {
      setManual(status);
      dropAtMulti(ids, status, index);
    },
    [setManual, dropAtMulti],
  );

  const { getFocusTerminal, focusTerminalByServerId } = useTaskTerminals({
    activeFolder,
    tasks,
    terminals,
    addTerminal,
    closeTerminals,
    closeTerminalsForTask,
    setActiveId,
  });
  const [viewing, setViewing] = useSyncedViewedTask(tasks);

  const submitNewTask = useCallback(
    async (title: string, desc?: string) => {
      if (!addingTo) return;
      if (await addTask(addingTo, title, desc)) setAddingTo(null);
    },
    [addTask, addingTo],
  );

  const moveViewingTask = useCallback(
    (status: TaskStatus) => {
      if (!viewing) return;
      moveTask(viewing.id, status);
    },
    [moveTask, viewing],
  );

  const deleteViewingTask = useCallback(async () => {
    if (!viewing) return;
    if (await deleteTask(viewing.id)) setViewing(null);
  }, [deleteTask, setViewing, viewing]);

  const saveViewingTask = useCallback(
    (updates: { title?: string; description?: string }) => {
      if (!viewing) return Promise.resolve(false);
      return editTask(viewing.id, updates);
    },
    [editTask, viewing],
  );

  const runViewingTask = useMemo(() => {
    if (
      !viewing ||
      (viewing.status !== 'open' &&
        !(viewing.status === 'in_progress' && !viewing.worktreePath))
    ) {
      return undefined;
    }
    return () => {
      runTask(viewing);
      setViewing(null);
    };
  }, [runTask, setViewing, viewing]);

  const focusPostMergeTerminal = focusTerminalByServerId(
    postMergeHook.active?.serverId,
  );

  return {
    activeCount,
    activePush,
    bulkStrips,
    cancelActiveRun,
    cancelQueuedRun,
    clearSelection,
    clearStuckConflicts,
    deleteTask,
    deleteViewingTask,
    dismissBulk,
    dismissRecent,
    draggingId,
    editTask,
    error,
    filteredGrouped,
    filteredTasks,
    focusPostMergeTerminal,
    getFocusTerminal,
    getLaneSortMode,
    handleDragEnd,
    handleDropAt,
    handleMultiDropAt,
    harness,
    harnessAvail,
    hasGit,
    mergeRun,
    mergeTaskAction,
    moveMulti,
    moveTask,
    moveViewingTask,
    piMenu,
    piModel,
    postMergeHook,
    qaPlaywright,
    rangeSelect,
    recentRunSummary,
    resumeTaskAction,
    runAllActionByLane,
    runTask,
    runViewingTask,
    saveViewingTask,
    searchActive,
    selectHarness,
    selectedIds,
    setAddingTo,
    setDraggingId,
    setError,
    setTaskSearch,
    setViewing,
    sortedGrouped,
    startPush,
    startQaRun,
    startAllQaRuns,
    submitNewTask,
    taskSearch,
    tasks,
    toggleLane,
    toggleLaneSort,
    toggleSelect,
    visibleLanes,
    viewing,
    addingTo,
  };
}
