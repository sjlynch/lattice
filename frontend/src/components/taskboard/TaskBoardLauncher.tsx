import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kanban } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { useTerminals } from '../../TerminalsContext';
import {
  cancelMergeRun as apiCancelMergeRun,
  createTask as apiCreateTask,
  deleteTask as apiDeleteTask,
  mergeTask as apiMergeTask,
  reorderTasks as apiReorderTasks,
  resumeTask as apiResumeTask,
  runTask as apiRunTask,
  startMergeRun as apiStartMergeRun,
  updateTask as apiUpdateTask,
  type Task,
  type TaskStatus,
} from '../../api';
import { ErrorToast } from '../shared/ErrorToast';
import { LANE_BY_ID, LANES, shortLabel } from './lanes';
import { Lane } from './Lane';
import { MergeRunStrip } from './MergeRunStrip';
import { NewTaskOverlay } from './NewTaskOverlay';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { useTaskList } from './hooks/useTaskList';
import { useMergeRunSync } from './hooks/useMergeRunSync';
import { usePushRun } from './hooks/usePushRun';
import { useHarnessSelector } from './hooks/useHarnessSelector';
import { useTaskSelection } from './hooks/useTaskSelection';

type Props = {
  activeFolder: string;
};

// Top-level Task Board: opens the floating panel and renders the lanes.
// Data-sync responsibilities (task list + WS, merge-run subscription, push
// polling, harness selector, multi-selection) live in the hooks under
// ./hooks; this component routes per-action calls (run/resume/merge/etc.)
// to the API + spawns the right terminal and owns the JSX shell.
export function TaskBoardLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<TaskStatus | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);

  // Filter state — all lanes visible by default.
  const [visibleLanes, setVisibleLanes] = useState<Set<TaskStatus>>(
    () => new Set(LANES.map((l) => l.id)),
  );

  const { addTerminal, closeTerminal, closeTerminalsForTask, terminals, setActiveId } =
    useTerminals();

  const { tasks, error, setError, showError } = useTaskList(activeFolder);
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

  // Group + sort tasks per lane. Tasks with an explicit sortOrder use it
  // directly; tasks without one fall back to `-createdAt` so newly-created
  // tasks land at the top of the lane (matches the prior newest-first
  // behavior).
  const grouped = useMemo(() => {
    const m: Record<TaskStatus, Task[]> = {
      backlog: [],
      open: [],
      in_progress: [],
      ready_to_merge: [],
      qa: [],
      done: [],
      deleted: [],
    };
    for (const t of tasks) m[t.status].push(t);
    for (const k of Object.keys(m) as TaskStatus[]) {
      m[k].sort(
        (a, b) =>
          (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt),
      );
    }
    return m;
  }, [tasks]);

  const {
    selectedIds,
    clearSelection,
    handleSingleSelect,
    handleToggleSelect,
    handleRangeSelect,
  } = useTaskSelection(tasks, grouped);

  // Build a taskId → most-recent-terminal-id map for the focus button.
  // A merge resolver and a worktree Claude can both exist for the same
  // task; the merge one is more interesting to focus on, so prefer 'merge'
  // kind, otherwise fall back to the most recently added terminal.
  const terminalByTaskId = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of terminals) {
      if (!t.taskId) continue;
      const existing = m.get(t.taskId);
      if (!existing) {
        m.set(t.taskId, t.id);
        continue;
      }
      if (t.kind === 'merge') m.set(t.taskId, t.id);
    }
    return m;
  }, [terminals]);

  const getFocusTerminal = useCallback(
    (task: Task): (() => void) | null => {
      const termId = terminalByTaskId.get(task.id);
      if (!termId) return null;
      return () => setActiveId(termId);
    },
    [terminalByTaskId, setActiveId],
  );

  // Auto-close terminals when their task reaches a terminal state. Runs on
  // every task update so it also catches stale sessionStorage terminals that
  // survive a server restart.
  useEffect(() => {
    for (const task of tasks) {
      if (
        task.status === 'qa' ||
        task.status === 'done' ||
        task.status === 'deleted'
      ) {
        closeTerminalsForTask(task.id);
      }
    }
  }, [tasks, closeTerminalsForTask]);

  // Keep "viewing" task fresh when underlying list updates.
  useEffect(() => {
    if (!viewing) return;
    const fresh = tasks.find((t) => t.id === viewing.id);
    if (!fresh) {
      setViewing(null);
      return;
    }
    if (fresh !== viewing) setViewing(fresh);
  }, [tasks, viewing]);

  async function addTask(status: TaskStatus, title: string, description?: string) {
    if (!activeFolder || !title.trim()) return;
    try {
      const created = await apiCreateTask(activeFolder, title, description);
      // If we're adding to a non-open lane, immediately update its status.
      if (status !== 'open') {
        await apiUpdateTask(created.id, { status });
      }
    } catch (err) {
      showError((err as Error).message);
    }
  }

  async function moveTask(id: string, status: TaskStatus) {
    try {
      await apiUpdateTask(id, { status });
    } catch (err) {
      showError((err as Error).message);
    }
  }

  // Move multiple tasks to a lane without a specific slot index (append).
  async function moveMulti(ids: string[], targetStatus: TaskStatus) {
    if (!activeFolder) return;
    const srcTasks = ids
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t)
      .sort((a, b) => (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt));
    if (!srcTasks.length) return;
    const newLane = grouped[targetStatus].filter((t) => !ids.includes(t.id));
    newLane.push(...srcTasks);
    try {
      await apiReorderTasks(activeFolder, targetStatus, newLane.map((t) => t.id));
      clearSelection();
    } catch (err) {
      showError((err as Error).message);
    }
  }

  // Drop multiple tasks at a specific position in the target lane.
  async function dropAtMulti(
    ids: string[],
    targetStatus: TaskStatus,
    targetIndex: number,
  ) {
    if (!activeFolder) return;
    const srcTasks = ids
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t)
      .sort((a, b) => (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt));
    if (!srcTasks.length) return;
    const targetLane = grouped[targetStatus].slice();
    const remaining = targetLane.filter((t) => !ids.includes(t.id));
    let insertAt = targetIndex;
    for (let i = 0; i < targetIndex && i < targetLane.length; i++) {
      if (ids.includes(targetLane[i].id)) insertAt--;
    }
    insertAt = Math.max(0, Math.min(insertAt, remaining.length));
    remaining.splice(insertAt, 0, ...srcTasks);
    try {
      await apiReorderTasks(activeFolder, targetStatus, remaining.map((t) => t.id));
      clearSelection();
    } catch (err) {
      showError((err as Error).message);
    }
  }

  // Drop handler used by lane drop slots. `targetIndex` is the position in
  // the destination lane's visible order where the task should land. Computes
  // the new ID order for the lane and ships it as a single batched reorder.
  async function dropAt(
    id: string,
    targetStatus: TaskStatus,
    targetIndex: number,
  ) {
    if (!activeFolder) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const lane = grouped[targetStatus].slice();
    const fromIdx = lane.findIndex((t) => t.id === id);
    let insertAt = targetIndex;
    if (fromIdx !== -1) {
      lane.splice(fromIdx, 1);
      if (fromIdx < insertAt) insertAt -= 1;
    }
    insertAt = Math.max(0, Math.min(insertAt, lane.length));
    if (fromIdx === insertAt && task.status === targetStatus) return;
    lane.splice(insertAt, 0, task);
    try {
      await apiReorderTasks(activeFolder, targetStatus, lane.map((t) => t.id));
    } catch (err) {
      showError((err as Error).message);
    }
  }

  async function editTask(
    id: string,
    updates: { title?: string; description?: string },
  ) {
    try {
      await apiUpdateTask(id, updates);
    } catch (err) {
      showError((err as Error).message);
    }
  }

  async function deleteTask(id: string) {
    try {
      await apiDeleteTask(id);
    } catch (err) {
      showError((err as Error).message);
    }
  }

  async function runTask(task: Task) {
    try {
      const res = await apiRunTask(task.id, pickInterleaveHarness());
      addTerminal({
        label: shortLabel(task.title),
        cwd: res.worktreePath,
        initialCommand: res.command,
        taskId: task.id,
        projectPath: task.projectPath,
        serverId: res.serverId,
      }, false);
    } catch (err) {
      showError(`Run failed: ${(err as Error).message}`);
    }
  }

  async function runAllOpen() {
    const openTasks = tasks
      .filter((t) => t.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of openTasks) {
      // sequentially to avoid hammering git
      // eslint-disable-next-line no-await-in-loop
      await runTask(t);
    }
  }

  async function resumeTaskAction(task: Task) {
    try {
      const res = await apiResumeTask(task.id, pickInterleaveHarness());
      addTerminal({
        label: shortLabel(task.title),
        cwd: res.worktreePath,
        initialCommand: res.command,
        taskId: task.id,
        projectPath: task.projectPath,
        serverId: res.serverId,
      }, false);
    } catch (err) {
      showError(`Resume failed: ${(err as Error).message}`);
    }
  }

  async function resumeAllInProgress() {
    const list = tasks
      .filter((t) => t.status === 'in_progress' && !!t.worktreePath)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of list) {
      // eslint-disable-next-line no-await-in-loop
      await resumeTaskAction(t);
    }
  }

  async function mergeTaskAction(task: Task): Promise<boolean> {
    try {
      const res = await apiMergeTask(task.id);
      if (res.merged) return true;
      // Either a worktree merge conflict or a stash-pop conflict in main —
      // both are handled by spawning a resolver Claude as a merge terminal.
      addTerminal({
        label: `merge:${shortLabel(task.title)}`,
        cwd: res.cwd,
        initialCommand: res.command,
        taskId: task.id,
        kind: 'merge',
        projectPath: task.projectPath,
        serverId: res.serverId,
      }, false);
      return false;
    } catch (err) {
      showError(`Merge failed: ${(err as Error).message}`);
      return false;
    }
  }

  async function mergeAllReady() {
    if (!activeFolder) return;
    try {
      await apiStartMergeRun(activeFolder);
      // Run is now backend-driven; UI subscribes to /ws/merge-runs for
      // progress and conflict events. Closing the panel/tab won't stop it.
    } catch (err) {
      showError(`Merge all failed to start: ${(err as Error).message}`);
    }
  }

  async function cancelActiveRun() {
    if (!mergeRun) return;
    try {
      await apiCancelMergeRun(mergeRun.id);
    } catch (err) {
      showError(`Cancel failed: ${(err as Error).message}`);
    }
  }

  async function markAllQaDone() {
    const qaTasks = tasks.filter((t) => t.status === 'qa');
    await Promise.all(qaTasks.map((t) => moveTask(t.id, 'done')));
  }

  const activeCount = tasks.filter(
    (t) =>
      t.status !== 'deleted' && t.status !== 'done' && t.status !== 'backlog',
  ).length;

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
        <div className="taskboard-filters">
          {LANES.map((lane) => {
            const on = visibleLanes.has(lane.id);
            return (
              <button
                key={lane.id}
                className={`taskboard-filter ${on ? '' : 'off'}`}
                onClick={() => toggleLane(lane.id)}
                title={on ? `Hide ${lane.label}` : `Show ${lane.label}`}
              >
                <span
                  className="taskboard-lane-dot"
                  style={{ background: lane.color }}
                />
                {lane.label}
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--text-tertiary)',
                    marginLeft: 2,
                  }}
                >
                  {grouped[lane.id].length}
                </span>
              </button>
            );
          })}
          {(harnessAvail.pi || harnessAvail.codex) && (
            <select
              className="taskboard-harness-select"
              value={harness}
              onChange={(e) => setHarness(e.target.value as 'claude' | 'pi' | 'codex' | 'interleave')}
              title="Agent harness for running tasks"
            >
              <option value="claude">Claude</option>
              {harnessAvail.pi && <option value="pi">Pi</option>}
              {harnessAvail.codex && <option value="codex">Codex</option>}
              {harnessAvail.pi && <option value="interleave">Interleave</option>}
            </select>
          )}
        </div>
        <div className="taskboard-body">
          <div className="taskboard-scroll">
            {LANES.filter((l) => visibleLanes.has(l.id)).map((lane) => (
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
                onSingleSelect={(id) => handleSingleSelect(id, lane.id)}
                onToggleSelect={(id) => handleToggleSelect(id, lane.id)}
                onRangeSelect={(id) => handleRangeSelect(id, lane.id)}
                onClearSelection={clearSelection}
                onRunAll={
                  lane.id === 'open'
                    ? runAllOpen
                    : lane.id === 'in_progress'
                    ? resumeAllInProgress
                    : lane.id === 'ready_to_merge'
                    ? mergeAllReady
                    : lane.id === 'qa'
                    ? markAllQaDone
                    : undefined
                }
                onPush={lane.id === 'qa' && hasGit ? startPush : undefined}
                pushDisabled={!!activePush}
                onView={setViewing}
                strip={(() => {
                  if (lane.id !== 'ready_to_merge') return undefined;
                  const hasConflicts = grouped['ready_to_merge'].some((t) => t.conflict);
                  if (!mergeRun && !recentRunSummary && !hasConflicts) return undefined;
                  return (
                    <MergeRunStrip
                      active={mergeRun}
                      summary={recentRunSummary}
                      tasks={tasks}
                      onCancel={cancelActiveRun}
                      onDismiss={dismissRecent}
                    />
                  );
                })()}
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
