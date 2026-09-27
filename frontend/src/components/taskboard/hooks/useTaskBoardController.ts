import { useCallback, useMemo } from 'react';
import { useTerminals } from '../../../TerminalsContext';
import { type TaskStatus } from '../../../api';
import { useLaneBulkActions } from './useLaneBulkActions';
import { useTaskActions } from './useTaskActions';
import { useTaskBoardDataView } from './useTaskBoardDataView';
import { useTaskBoardDetailActions } from './useTaskBoardDetailActions';
import { useTaskBoardRunControllers } from './useTaskBoardRunControllers';
import { useTaskSpawnHandler } from './useTaskSpawnHandler';
import { useTaskTerminals } from './useTaskTerminals';

// Central controller for the taskboard panel. It composes three focused slices:
// data/view state, run controllers, and detail/editing actions. Keeping the
// slices separate makes this hook cross-concern wiring rather than another home
// for taskboard business logic, while preserving the public shape consumed by
// TaskBoardLauncher.
export function useTaskBoardController(activeFolder: string) {
  const {
    addTerminal,
    closeTerminal,
    closeTerminals,
    closeTerminalsForTask,
    terminals,
    setActiveId,
  } = useTerminals();

  // `task-spawned` → mount the (queued) task's terminal + ping the resume strip.
  // It closes any stale tab for the task first (the Resume case re-spawns with a
  // fresh serverId), so a task never ends up with two tabs.
  // `setBulkSpawnNotifier` bridges in the strip's notifier later (it's produced
  // after the task list, which needs `handleTaskSpawned`).
  const { handleTaskSpawned, setBulkSpawnNotifier } = useTaskSpawnHandler(
    addTerminal,
    closeTerminalsForTask,
  );

  const data = useTaskBoardDataView(activeFolder, handleTaskSpawned);
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
    visibleLanes,
    toggleLane,
    getLaneSortMode,
    toggleLaneSort,
    setManual,
    taskSearch,
    setTaskSearch,
    searchActive,
    filteredTasks,
    filteredGrouped,
    sortedGrouped,
    draggingId,
    setDraggingId,
    handleDragEnd,
  } = data;

  // The QA-run hook reads the open tabs to tell a run still under test from
  // one whose tab was closed, and focuses the existing tab on a repeat ▶.
  const qaRunTerminals = useMemo(
    () => ({ terminals, focusTerminal: setActiveId }),
    [terminals, setActiveId],
  );
  const runs = useTaskBoardRunControllers(
    activeFolder,
    addTerminal,
    closeTerminal,
    closeTerminalsForTask,
    showError,
    qaRunTerminals,
  );
  const {
    mergeRun,
    recentRunSummary,
    dismissRecent,
    activePush,
    startPush,
    hasGit,
    harness,
    piModel,
    piMenu,
    selectHarness,
    harnessAvail,
    pickRunHarness,
    qaPlaywright,
    startQaRun,
    startAllQaRuns,
    runningTaskIds: runningQaTaskIds,
    postMergeHook,
  } = runs;

  const taskActions = useTaskActions({
    activeFolder,
    tasks,
    grouped,
    visibleGrouped: filteredGrouped,
    getLaneSortMode,
    mergeRun,
    addTerminal,
    clearSelection,
    pickRunHarness,
    showError,
    // The conflict pill / Merge focuses a still-running resolver's tab
    // instead of spawning a second one.
    terminals,
    focusTerminal: setActiveId,
    closeTerminalsForTask,
  });
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
  } = taskActions;

  // Live progress strips for the Open/In Progress/QA lane bulk actions
  // (mirrors the Ready-to-Merge MergeRunStrip), plus the per-lane "run all"
  // action map. Owns the strip state and bridges the resume notifier back to
  // the spawn handler via `setBulkSpawnNotifier`.
  const { runAllActionByLane, bulkStrips, dismissBulk } = useLaneBulkActions({
    activeFolder,
    tasks,
    setBulkSpawnNotifier,
    runAllOpen,
    resumeAllInProgress,
    mergeAllReady,
    markAllQaDone,
  });

  // The reorder math splices into the display order the user saw. Dropping at
  // an explicit slot flips that lane to manual before delegating to the task
  // action so the hand-ordering survives until the next clock toggle.
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

  const detail = useTaskBoardDetailActions({
    tasks,
    addTask,
    moveTask,
    deleteTask,
    editTask,
    runTask,
  });

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
    deleteViewingTask: detail.deleteViewingTask,
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
    moveViewingTask: detail.moveViewingTask,
    piMenu,
    piModel,
    postMergeHook,
    qaPlaywright,
    rangeSelect,
    recentRunSummary,
    resumeTaskAction,
    runAllActionByLane,
    runTask,
    runViewingTask: detail.runViewingTask,
    saveViewingTask: detail.saveViewingTask,
    searchActive,
    selectHarness,
    selectedIds,
    setAddingTo: detail.setAddingTo,
    setDraggingId,
    setError,
    setTaskSearch,
    setViewing: detail.setViewing,
    sortedGrouped,
    startPush,
    startQaRun,
    startAllQaRuns,
    runningQaTaskIds,
    submitNewTask: detail.submitNewTask,
    taskSearch,
    tasks,
    toggleLane,
    toggleLaneSort,
    toggleSelect,
    visibleLanes,
    viewing: detail.viewing,
    addingTo: detail.addingTo,
  };
}
