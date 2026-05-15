import { useCallback, useMemo, useState } from 'react';
import { Kanban } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { useTerminals } from '../../TerminalsContext';
import { type Task, type TaskStatus } from '../../api';
import { ErrorToast } from '../shared/ErrorToast';
import { LANE_BY_ID, LANES } from './lanes';
import { Lane } from './Lane';
import { mergeRunStripFor } from './MergeRunStrip';
import { NewTaskOverlay } from './NewTaskOverlay';
import { TaskBoardFilters } from './TaskBoardFilters';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { useMergeRunSync } from './hooks/useMergeRunSync';
import { usePushRun } from './hooks/usePushRun';
import { useHarnessSelector } from './hooks/useHarnessSelector';
import { useTaskActions } from './hooks/useTaskActions';
import { useTaskBoardState } from './hooks/useTaskBoardState';
import { useTaskTerminalCleanup } from './hooks/useTaskTerminalCleanup';
import { useSyncedViewedTask } from './hooks/useSyncedViewedTask';
import { buildTerminalMap } from '../../utils/terminalMap';

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

  // Filter state — all lanes visible by default.
  const [visibleLanes, setVisibleLanes] = useState<Set<TaskStatus>>(
    () => new Set(LANES.map((lane) => lane.id)),
  );

  const {
    addTerminal,
    closeTerminal,
    closeTerminals,
    closeTerminalsForTask,
    terminals,
    setActiveId,
  } = useTerminals();

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
  } = useTaskBoardState(activeFolder);
  const { mergeRun, recentRunSummary, dismissRecent } = useMergeRunSync(
    activeFolder,
    addTerminal,
  );
  const { activePush, startPush, hasGit } = usePushRun(
    activeFolder,
    addTerminal,
    closeTerminal,
    showError,
  );
  const { harness, setHarness, harnessAvail, pickInterleaveHarness } =
    useHarnessSelector(activeFolder);
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

  const terminalByTaskId = useMemo(
    () => buildTerminalMap(terminals, tasks),
    [terminals, tasks],
  );

  const getFocusTerminal = useCallback(
    (task: Task): (() => void) | null => {
      const termId = terminalByTaskId.get(task.id);
      if (!termId) return null;
      return () => setActiveId(termId);
    },
    [terminalByTaskId, setActiveId],
  );

  useTaskTerminalCleanup(
    tasks,
    terminals,
    closeTerminalsForTask,
    closeTerminals,
  );
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

  function toggleLane(id: TaskStatus) {
    setVisibleLanes((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
          <>
            <Kanban size={13} />
            Task board
          </>
        }
        defaultSize={{ width: 720, height: 620 }}
        minSize={{ width: 460, height: 380 }}
        storageKey="lattice.taskboard.window"
      >
        <TaskBoardFilters
          lanes={LANES}
          visibleLanes={visibleLanes}
          grouped={grouped}
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
                tasks={grouped[lane.id]}
                draggingId={draggingId}
                selectedIds={selectedIds}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
                onAdd={() => setAddingTo(lane.id)}
                onMove={moveTask}
                onDropAt={dropAt}
                onMultiMove={moveMulti}
                onMultiDropAt={dropAtMulti}
                onDelete={deleteTask}
                onRun={runTask}
                onResume={resumeTaskAction}
                onMerge={mergeTaskAction}
                getFocusTerminal={getFocusTerminal}
                onSingleSelect={(id) => selectSingle(id, lane.id)}
                onToggleSelect={(id) => toggleSelect(id, lane.id)}
                onRangeSelect={(id) => rangeSelect(id, lane.id)}
                onClearSelection={clearSelection}
                onRunAll={runAllActionByLane[lane.id]}
                onPush={lane.id === 'qa' && hasGit ? startPush : undefined}
                pushDisabled={!!activePush}
                onView={setViewing}
                strip={mergeRunStripFor(
                  lane,
                  grouped[lane.id],
                  mergeRun,
                  recentRunSummary,
                  tasks,
                  cancelActiveRun,
                  dismissRecent,
                )}
              />
            ))}
          </div>
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
                viewing.status === 'open'
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
        <div className="taskboard-footer">
          {tasks.length} total · drag to reorder · click to select · ctrl+click or shift+click to multi-select · pencil to edit
        </div>
      </FloatingPanel>
    </>
  );
}
