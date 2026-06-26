import { useCallback, useMemo, useState } from 'react';
import { Kanban } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { useTerminals } from '../../TerminalsContext';
import { type TaskStatus } from '../../api';
import { ErrorToast } from '../shared/ErrorToast';
import { LANE_BY_ID, LANES } from './lanes';
import { sortTasksForLane } from './laneSort';
import { NewTaskOverlay } from './NewTaskOverlay';
import { PostMergeHookRow } from './PostMergeHookRow';
import { TaskBoardFilters } from './TaskBoardFilters';
import { TaskBoardFooter } from './TaskBoardFooter';
import { TaskBoardLaneGrid } from './TaskBoardLaneGrid';
import { TaskBoardSearchEmpty } from './TaskBoardSearchEmpty';
import { TaskBoardTitle } from './TaskBoardTitle';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { useMergeRunSync } from './hooks/useMergeRunSync';
import { usePostMergeHook } from './hooks/usePostMergeHook';
import { usePushRun } from './hooks/usePushRun';
import { useHarnessSelector } from './hooks/useHarnessSelector';
import { useQaPlaywright } from './hooks/useQaPlaywright';
import { useQaRuns } from './hooks/useQaRuns';
import { useLaneSort } from './hooks/useLaneSort';
import { useLaneBulkActions } from './hooks/useLaneBulkActions';
import { useTaskActions } from './hooks/useTaskActions';
import { useTaskBoardState } from './hooks/useTaskBoardState';
import { useTaskSearch } from './hooks/useTaskSearch';
import { useTaskSpawnHandler } from './hooks/useTaskSpawnHandler';
import { useTaskTerminals } from './hooks/useTaskTerminals';
import { useSyncedViewedTask } from './hooks/useSyncedViewedTask';
import { useVisibleLanes } from './hooks/useVisibleLanes';

type Props = {
  activeFolder: string;
};

// Top-level Task Board: opens the floating panel and renders the lanes.
// Data-sync/state responsibilities live in hooks under ./hooks; this
// component wires those hooks to the JSX shell and keeps UI-only state local.
export function TaskBoardLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
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

  return (
    <>
      <button
        className="fab"
        onClick={() => setOpen(true)}
        title="Open task board"
        aria-label="Open task board"
      >
        <Kanban size={15} />
        <span>Tasks</span>
        {activeCount > 0 && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginLeft: 2,
            }}
          >
            · {activeCount}
          </span>
        )}
      </button>

      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        title={
          <TaskBoardTitle taskSearch={taskSearch} setTaskSearch={setTaskSearch} />
        }
        defaultSize={{ width: 720, height: 620 }}
        minSize={{ width: 460, height: 380 }}
        storageKey="lattice.taskboard.window"
      >
        <TaskBoardFilters
          lanes={LANES}
          visibleLanes={visibleLanes}
          grouped={filteredGrouped}
          harness={harness}
          piModel={piModel}
          piMenu={piMenu}
          selectHarness={selectHarness}
          harnessAvail={harnessAvail}
          onToggleLane={toggleLane}
        />
        <div className="taskboard-body">
          <div className="taskboard-scroll">
            {searchActive && filteredTasks.length === 0 ? (
              <TaskBoardSearchEmpty
                query={taskSearch.trim()}
                onClear={() => setTaskSearch('')}
              />
            ) : (
              <TaskBoardLaneGrid
                visibleLanes={visibleLanes}
                sortedGrouped={sortedGrouped}
                qaTasks={filteredGrouped.qa}
                tasks={tasks}
                draggingId={draggingId}
                selectedIds={selectedIds}
                onDragStart={setDraggingId}
                onDragEnd={handleDragEnd}
                onToggleSelect={toggleSelect}
                onRangeSelect={rangeSelect}
                onClearSelection={clearSelection}
                onAdd={setAddingTo}
                onMove={moveTask}
                onDropAt={handleDropAt}
                onMultiMove={moveMulti}
                onMultiDropAt={handleMultiDropAt}
                onDelete={deleteTask}
                onRun={runTask}
                onCancelQueuedRun={cancelQueuedRun}
                onResume={resumeTaskAction}
                onMerge={mergeTaskAction}
                onView={setViewing}
                getFocusTerminal={getFocusTerminal}
                getLaneSortMode={getLaneSortMode}
                onToggleSort={toggleLaneSort}
                searchActive={searchActive}
                runAllActionByLane={runAllActionByLane}
                hasGit={hasGit}
                onPush={startPush}
                pushDisabled={!!activePush}
                qaPlaywright={qaPlaywright}
                onQaRun={startQaRun}
                onQaRunAll={startAllQaRuns}
                mergeRun={mergeRun}
                recentRunSummary={recentRunSummary}
                onCancelActiveRun={cancelActiveRun}
                onClearStuckConflicts={clearStuckConflicts}
                onDismissRecent={dismissRecent}
                bulkStrips={bulkStrips}
                onDismissBulk={dismissBulk}
              />
            )}
          </div>
          <PostMergeHookRow
            prompt={postMergeHook.form.prompt}
            harness={postMergeHook.form.harness}
            piModel={postMergeHook.form.piModel}
            piMenu={piMenu}
            harnessAvail={harnessAvail}
            active={postMergeHook.active}
            recent={postMergeHook.recent}
            saving={postMergeHook.saving}
            onSavePrompt={postMergeHook.savePrompt}
            onSaveHarness={postMergeHook.saveHarness}
            onAbort={postMergeHook.abort}
            onFocusActiveTerminal={focusTerminalByServerId(
              postMergeHook.active?.serverId,
            )}
          />
          {addingTo && (
            <NewTaskOverlay
              lane={LANE_BY_ID[addingTo]}
              onCancel={() => setAddingTo(null)}
              onSubmit={async (title, desc) => {
                if (await addTask(addingTo, title, desc)) setAddingTo(null);
              }}
            />
          )}
          {viewing && (
            <TaskDetailOverlay
              task={viewing}
              onClose={() => setViewing(null)}
              onMove={(status) => moveTask(viewing.id, status)}
              onDelete={async () => {
                if (await deleteTask(viewing.id)) setViewing(null);
              }}
              onSave={(updates) => editTask(viewing.id, updates)}
              onRun={
                viewing.status === 'open' ||
                (viewing.status === 'in_progress' && !viewing.worktreePath)
                  ? () => {
                      runTask(viewing);
                      setViewing(null);
                    }
                  : undefined
              }
            />
          )}
          {error && (
            <ErrorToast message={error} onDismiss={() => setError(null)} />
          )}
        </div>
        <TaskBoardFooter
          tasks={tasks}
          filteredTasks={filteredTasks}
          searchActive={searchActive}
        />
      </FloatingPanel>
    </>
  );
}
