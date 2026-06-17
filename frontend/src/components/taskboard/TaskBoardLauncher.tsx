import { useCallback, useMemo, useState } from 'react';
import { Kanban } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { useTerminals } from '../../TerminalsContext';
import {
  type TaskSpawnedEvent,
  type TaskStatus,
} from '../../api';
import { ErrorToast } from '../shared/ErrorToast';
import { LANE_BY_ID, LANES, shortLabel } from './lanes';
import { Lane } from './Lane';
import { mergeRunStripFor } from './MergeRunStrip';
import { NewTaskOverlay } from './NewTaskOverlay';
import { PostMergeHookRow } from './PostMergeHookRow';
import { TaskBoardFilters } from './TaskBoardFilters';
import { TaskBoardFooter } from './TaskBoardFooter';
import { TaskBoardTitle } from './TaskBoardTitle';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { useMergeRunSync } from './hooks/useMergeRunSync';
import { usePostMergeHook } from './hooks/usePostMergeHook';
import { usePushRun } from './hooks/usePushRun';
import { useHarnessSelector } from './hooks/useHarnessSelector';
import { useQaPlaywright } from './hooks/useQaPlaywright';
import { useTaskActions } from './hooks/useTaskActions';
import { useTaskBoardState } from './hooks/useTaskBoardState';
import { useTaskSearch } from './hooks/useTaskSearch';
import { useTaskTerminalCleanup } from './hooks/useTaskTerminalCleanup';
import { useTaskTerminalFocus } from './hooks/useTaskTerminalFocus';
import { useTaskTerminalReattach } from './hooks/useTaskTerminalReattach';
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

  // A queued task's run has no pty at request time; when the spawn queue
  // admits it the backend emits `task-spawned` over /ws/tasks. Mount the
  // task's terminal here (lazy — the pane only renders on activation). Every
  // tab watching the project mounts it, matching the workflow step model.
  const handleTaskSpawned = useCallback(
    (event: TaskSpawnedEvent) => {
      addTerminal(
        {
          label: shortLabel(event.title),
          cwd: event.worktreePath,
          initialCommand: event.command,
          taskId: event.taskId,
          projectPath: event.projectPath,
          serverId: event.serverId,
        },
        false,
      );
    },
    [addTerminal],
  );

  const {
    tasks,
    grouped,
    activeCount,
    error,
    setError,
    showError,
    selectedIds,
    clearSelection,
    selectSingle,
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
  const { harness, setHarness, harnessAvail, pickInterleaveHarness } =
    useHarnessSelector(activeFolder);
  const qaPlaywright = useQaPlaywright(activeFolder);
  const postMergeHook = usePostMergeHook(activeFolder, addTerminal, showError);
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
    markAllQaDone,
  } = useTaskActions({
    activeFolder,
    tasks,
    grouped,
    mergeRun,
    addTerminal,
    clearSelection,
    pickInterleaveHarness,
    showError,
  });

  const {
    taskSearch,
    setTaskSearch,
    searchActive,
    filteredTasks,
    filteredGrouped,
  } = useTaskSearch(tasks);

  const { getFocusTerminal, focusTerminalByServerId } = useTaskTerminalFocus(
    terminals,
    tasks,
    setActiveId,
  );

  useTaskTerminalCleanup(
    tasks,
    terminals,
    closeTerminalsForTask,
    closeTerminals,
  );
  // Re-mount terminals for in_progress tasks whose pty is still alive but
  // was never delivered to this tab (queued task admitted while all tabs
  // were closed; fresh tab after a backend restart).
  useTaskTerminalReattach(activeFolder, tasks, terminals, addTerminal);
  const [viewing, setViewing] = useSyncedViewedTask(tasks);

  const runAllActionByLane = useMemo<Partial<Record<TaskStatus, () => void>>>(
    () => ({
      open: runAllOpen,
      in_progress: resumeAllInProgress,
      ready_to_merge: mergeAllReady,
      qa: markAllQaDone,
    }),
    [runAllOpen, resumeAllInProgress, mergeAllReady, markAllQaDone],
  );

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
          setHarness={setHarness}
          harnessAvail={harnessAvail}
          onToggleLane={toggleLane}
        />
        <div className="taskboard-body">
          <div className="taskboard-scroll">
            {LANES.filter((lane) => visibleLanes.has(lane.id)).map((lane) => (
              <Lane
                key={lane.id}
                lane={lane}
                tasks={filteredGrouped[lane.id]}
                draggingId={draggingId}
                selectedIds={selectedIds}
                onDragStart={setDraggingId}
                onDragEnd={handleDragEnd}
                onAdd={() => setAddingTo(lane.id)}
                onMove={moveTask}
                onDropAt={dropAt}
                onMultiMove={moveMulti}
                onMultiDropAt={dropAtMulti}
                onDelete={deleteTask}
                onRun={runTask}
                onCancelQueuedRun={cancelQueuedRun}
                onResume={resumeTaskAction}
                onMerge={mergeTaskAction}
                getFocusTerminal={getFocusTerminal}
                onSingleSelect={selectSingle}
                onToggleSelect={toggleSelect}
                onRangeSelect={rangeSelect}
                onClearSelection={clearSelection}
                onRunAll={
                  searchActive ? undefined : runAllActionByLane[lane.id]
                }
                onPush={lane.id === 'qa' && hasGit ? startPush : undefined}
                pushDisabled={!!activePush}
                qaPlaywright={lane.id === 'qa' ? qaPlaywright : undefined}
                onView={setViewing}
                strip={mergeRunStripFor(
                  lane,
                  filteredGrouped[lane.id],
                  mergeRun,
                  recentRunSummary,
                  tasks,
                  cancelActiveRun,
                  dismissRecent,
                )}
              />
            ))}
          </div>
          <PostMergeHookRow
            prompt={postMergeHook.form.prompt}
            harness={postMergeHook.form.harness}
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
              onSubmit={(title, desc) => {
                addTask(addingTo, title, desc);
                setAddingTo(null);
              }}
            />
          )}
          {viewing && (
            <TaskDetailOverlay
              task={viewing}
              onClose={() => setViewing(null)}
              onMove={(status) => moveTask(viewing.id, status)}
              onDelete={() => {
                deleteTask(viewing.id);
                setViewing(null);
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
