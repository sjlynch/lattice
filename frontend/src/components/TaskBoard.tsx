import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Kanban,
  Plus,
  Trash2,
  GripVertical,
  Play,
  X,
  GitMerge,
  AlertTriangle,
  Copy,
  Check,
  CheckCheck,
} from 'lucide-react';
import { FloatingPanel } from './FloatingPanel';
import { useTerminals } from '../TerminalsContext';
import {
  cancelMergeRun as apiCancelMergeRun,
  createTask as apiCreateTask,
  deleteTask as apiDeleteTask,
  fetchTasks,
  fetchUserSettings,
  getActiveMergeRun,
  mergeTask as apiMergeTask,
  patchUserSettings,
  reorderTasks as apiReorderTasks,
  resumeTask as apiResumeTask,
  runTask as apiRunTask,
  startMergeRun as apiStartMergeRun,
  subscribeMergeRuns,
  subscribeTasks,
  updateTask as apiUpdateTask,
  type MergeRun,
  type Task,
  type TaskStatus,
} from '../api';

const LANES: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'backlog', label: 'Backlog', color: '#7a8fa8' },
  { id: 'open', label: 'Open', color: '#6aa9ff' },
  { id: 'in_progress', label: 'In Progress', color: '#e7c986' },
  { id: 'ready_to_merge', label: 'Ready to Merge', color: '#5eead4' },
  { id: 'qa', label: 'QA', color: '#c89cff' },
  { id: 'done', label: 'Done', color: '#9ed28e' },
  { id: 'deleted', label: 'Deleted', color: '#7c8088' },
];

const LANE_BY_ID: Record<TaskStatus, (typeof LANES)[number]> = LANES.reduce(
  (acc, l) => {
    acc[l.id] = l;
    return acc;
  },
  {} as Record<TaskStatus, (typeof LANES)[number]>,
);

const DRAG_MIME = 'application/x-lattice-task';

type Props = {
  activeFolder: string;
};

export function TaskBoardLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<TaskStatus | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeRun, setMergeRun] = useState<MergeRun | null>(null);
  const [recentRunSummary, setRecentRunSummary] = useState<MergeRun | null>(
    null,
  );
  const [harness, setHarness] = useState<'claude' | 'pi'>('claude');

  // Filter state — all lanes visible by default.
  const [visibleLanes, setVisibleLanes] = useState<Set<TaskStatus>>(
    () => new Set(LANES.map((l) => l.id)),
  );

  const { addTerminal, closeTerminalsForTask } = useTerminals();

  // Auto-close terminals when their task reaches a terminal state.
  // Runs on every task update so it also catches stale localStorage
  // terminals that survive a server restart.
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

  // Initial load + WS subscription per active folder.
  useEffect(() => {
    if (!activeFolder) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    fetchTasks(activeFolder)
      .then((ts) => {
        if (!cancelled) setTasks(ts);
      })
      .catch((err) => console.error('fetchTasks', err));
    const unsub = subscribeTasks(activeFolder, (ts) => {
      if (!cancelled) setTasks(ts);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder]);

  // Load persisted harness preference when the active folder changes.
  useEffect(() => {
    if (!activeFolder) return;
    fetchUserSettings(activeFolder)
      .then((s) => { if (s.harness) setHarness(s.harness); })
      .catch(() => { /* keep default */ });
  }, [activeFolder]);

  // Hydrate the active merge run on mount and subscribe to live events.
  // Closing the panel/tab doesn't cancel the run — it keeps progressing on
  // the backend. On reopen we resync via /api/merge-runs/active.
  useEffect(() => {
    if (!activeFolder) {
      setMergeRun(null);
      return;
    }
    let cancelled = false;
    getActiveMergeRun(activeFolder)
      .then((r) => {
        if (!cancelled) setMergeRun(r);
      })
      .catch(() => {
        /* ignore */
      });
    const unsub = subscribeMergeRuns(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type === 'idle') {
        // Server confirmed no active run — clear any stale state left over
        // from a run that completed while the WS was disconnected.
        setMergeRun(null);
      } else if (ev.type === 'started' || ev.type === 'progress') {
        setMergeRun(ev.run);
      } else if (ev.type === 'completed' || ev.type === 'cancelled') {
        setMergeRun(null);
        setRecentRunSummary(ev.run);
        // Auto-clear summary after a few seconds.
        setTimeout(() => {
          setRecentRunSummary((cur) => (cur?.id === ev.run.id ? null : cur));
        }, 8000);
      } else if (ev.type === 'conflict') {
        // Spawn the resolver Claude in the worktree. Same flow the per-card
        // merge button uses; the run worker doesn't have UI access so the
        // frontend handles the terminal half.
        addTerminal({
          label: `merge:${ev.taskId.slice(-6)}`,
          cwd: ev.cwd,
          initialCommand: ev.command,
          taskId: ev.taskId,
          kind: 'merge',
        });
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder, addTerminal]);

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

  function showError(msg: string) {
    setError(msg);
    setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 5000);
  }

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
      const res = await apiRunTask(task.id, harness);
      addTerminal({
        label: shortLabel(task.title),
        cwd: res.worktreePath,
        initialCommand: res.command,
        taskId: task.id,
      });
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
      const res = await apiResumeTask(task.id, harness);
      addTerminal({
        label: shortLabel(task.title),
        cwd: res.worktreePath,
        initialCommand: res.command,
        taskId: task.id,
      });
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
      });
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
      // Tasks with an explicit sortOrder use it directly. Tasks without one
      // fall back to `-createdAt` so newly-created tasks land at the top of
      // the lane (matches the prior newest-first behavior).
      m[k].sort(
        (a, b) =>
          (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt),
      );
    }
    return m;
  }, [tasks]);

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

  function toggleHarness() {
    const next: 'claude' | 'pi' = harness === 'claude' ? 'pi' : 'claude';
    setHarness(next);
    if (activeFolder) patchUserSettings(activeFolder, { harness: next }).catch(() => {});
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
          <button
            className="taskboard-filter taskboard-harness-toggle"
            onClick={toggleHarness}
            title={harness === 'claude' ? 'Switch to Pi agent coder' : 'Switch to Claude Code'}
            style={{ marginLeft: 'auto' }}
          >
            {harness === 'claude' ? 'Claude' : 'Pi'}
          </button>
        </div>
        <div className="taskboard-body">
          <div className="taskboard-scroll">
            {LANES.filter((l) => visibleLanes.has(l.id)).map((lane) => (
              <Lane
                key={lane.id}
                lane={lane}
                tasks={grouped[lane.id]}
                draggingId={draggingId}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
                onAdd={() => setAddingTo(lane.id)}
                onMove={moveTask}
                onDropAt={dropAt}
                onDelete={deleteTask}
                onRun={runTask}
                onResume={resumeTaskAction}
                onMerge={mergeTaskAction}
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
                onView={setViewing}
                strip={
                  lane.id === 'ready_to_merge' && (mergeRun || recentRunSummary) ? (
                    <MergeRunStrip
                      active={mergeRun}
                      summary={recentRunSummary}
                      tasks={tasks}
                      onCancel={cancelActiveRun}
                      onDismiss={() => setRecentRunSummary(null)}
                    />
                  ) : undefined
                }
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
          {tasks.length} total · drag tasks between or within lanes to reorder
          · click a card to view
        </div>
      </FloatingPanel>
    </>
  );
}

function shortLabel(title: string): string {
  const t = title.trim();
  return t.length > 18 ? t.slice(0, 17) + '…' : t;
}

function Lane({
  lane,
  tasks,
  draggingId,
  onDragStart,
  onDragEnd,
  onAdd,
  onMove,
  onDropAt,
  onDelete,
  onRun,
  onResume,
  onMerge,
  onRunAll,
  onView,
  strip,
}: {
  lane: (typeof LANES)[number];
  tasks: Task[];
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onAdd: () => void;
  onMove: (id: string, status: TaskStatus) => void;
  onDropAt: (id: string, status: TaskStatus, index: number) => void;
  onDelete: (id: string) => void;
  onRun: (task: Task) => void;
  onResume: (task: Task) => void;
  onMerge: (task: Task) => Promise<boolean>;
  onRunAll?: () => void;
  onView: (task: Task) => void;
  strip?: ReactNode;
}) {
  const [isOver, setIsOver] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  function onDragOver(e: React.DragEvent) {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isOver) setIsOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsOver(false);
    setHoverIndex(null);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const id =
      e.dataTransfer.getData(DRAG_MIME) ||
      e.dataTransfer.getData('text/plain');
    if (id) {
      // Slot drop = explicit position; lane background drop = status-only move
      // (preserves the previous "drop anywhere on lane to change status"
      // behavior for users who don't care about position).
      if (hoverIndex !== null) onDropAt(id, lane.id, hoverIndex);
      else onMove(id, lane.id);
    }
    setIsOver(false);
    setHoverIndex(null);
  }

  function slotProps(idx: number) {
    return {
      onDragEnter: (e: React.DragEvent) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        setHoverIndex(idx);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (hoverIndex !== idx) setHoverIndex(idx);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const id =
          e.dataTransfer.getData(DRAG_MIME) ||
          e.dataTransfer.getData('text/plain');
        if (id) onDropAt(id, lane.id, idx);
        setIsOver(false);
        setHoverIndex(null);
      },
    };
  }

  const dragging = !!draggingId;

  return (
    <div
      className={`taskboard-lane ${isOver ? 'drop-target' : ''} ${
        dragging ? 'dragging-active' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="taskboard-lane-head">
        <span className="taskboard-lane-title">
          <span
            className="taskboard-lane-dot"
            style={{ background: lane.color }}
          />
          {lane.label}
          <span className="taskboard-lane-count">{tasks.length}</span>
          {onRunAll && (
            <button
              className={`lane-runall ${
                lane.id === 'ready_to_merge'
                  ? 'merge'
                  : lane.id === 'in_progress'
                  ? 'resume'
                  : lane.id === 'qa'
                  ? 'qa-done'
                  : ''
              }`}
              onClick={onRunAll}
              disabled={
                lane.id === 'in_progress'
                  ? tasks.filter((t) => !!t.worktreePath).length === 0
                  : tasks.length === 0
              }
              title={
                lane.id === 'ready_to_merge'
                  ? 'Merge every Ready-to-Merge task (stops on first conflict)'
                  : lane.id === 'in_progress'
                  ? 'Resume every In Progress task with an existing worktree'
                  : lane.id === 'qa'
                  ? 'Mark every QA task as Done'
                  : 'Run every task in Open in a new worktree'
              }
              aria-label={
                lane.id === 'ready_to_merge'
                  ? 'Merge all ready tasks'
                  : lane.id === 'in_progress'
                  ? 'Resume all in-progress tasks'
                  : lane.id === 'qa'
                  ? 'Mark all QA tasks done'
                  : 'Run all open tasks'
              }
            >
              {lane.id === 'ready_to_merge' ? (
                <GitMerge size={11} />
              ) : lane.id === 'qa' ? (
                <CheckCheck size={12} />
              ) : (
                <Play size={11} fill="currentColor" />
              )}
            </button>
          )}
        </span>
        <div className="taskboard-lane-actions">
          <button
            className="icon-btn sm"
            onClick={onAdd}
            title="Add task"
            aria-label="Add task"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      {strip}
      <div className="taskboard-lane-track">
        {tasks.length === 0 ? (
          <div
            className={`taskboard-lane-empty ${
              dragging && hoverIndex === 0 ? 'slot-active' : ''
            }`}
            {...slotProps(0)}
          >
            {isOver ? 'Drop here' : 'No tasks'}
          </div>
        ) : (
          <>
            <div
              className={`taskboard-dropslot ${
                hoverIndex === 0 ? 'active' : ''
              }`}
              style={{ ['--lane-color' as string]: lane.color }}
              {...slotProps(0)}
            />
            {tasks.map((t, i) => (
              <Fragment key={t.id}>
                <TaskCard
                  task={t}
                  laneColor={lane.color}
                  isDragging={draggingId === t.id}
                  onDragStart={() => onDragStart(t.id)}
                  onDragEnd={onDragEnd}
                  onDelete={() => onDelete(t.id)}
                  onRun={lane.id === 'open' ? () => onRun(t) : undefined}
                  onResume={
                    lane.id === 'in_progress' && t.worktreePath
                      ? () => onResume(t)
                      : undefined
                  }
                  onMerge={
                    lane.id === 'ready_to_merge'
                      ? () => onMerge(t)
                      : undefined
                  }
                  onView={() => onView(t)}
                />
                <div
                  className={`taskboard-dropslot ${
                    hoverIndex === i + 1 ? 'active' : ''
                  }`}
                  style={{ ['--lane-color' as string]: lane.color }}
                  {...slotProps(i + 1)}
                />
              </Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function NewTaskOverlay({
  lane,
  onSubmit,
  onCancel,
}: {
  lane: (typeof LANES)[number];
  onSubmit: (title: string, desc?: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function submit() {
    if (!title.trim()) return;
    onSubmit(title, desc || undefined);
  }

  return (
    <div className="taskboard-overlay" onMouseDown={onCancel}>
      <div className="taskboard-newform" onMouseDown={(e) => e.stopPropagation()}>
        <div className="taskboard-newform-head">
          <span
            className="taskboard-lane-dot"
            style={{ background: lane.color }}
          />
          New task in {lane.label}
        </div>
        <div className="taskboard-newform-body">
          <input
            ref={titleRef}
            className="task-card-form-input"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <textarea
            className="task-card-form-input task-card-form-textarea"
            placeholder="Description (optional)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={4}
          />
        </div>
        <div className="taskboard-newform-actions">
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={!title.trim()}
          >
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskDetailOverlay({
  task,
  onClose,
  onMove,
  onDelete,
  onSave,
  onRun,
}: {
  task: Task;
  onClose: () => void;
  onMove: (status: TaskStatus) => void;
  onDelete: () => void;
  onSave: (updates: { title?: string; description?: string }) => void;
  onRun?: () => void;
}) {
  const [editing, setEditing] = useState(true);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description ?? '');

  // When the underlying task changes (e.g., WS update), refresh edit fields if
  // we're not in edit mode — avoid clobbering in-progress edits.
  useEffect(() => {
    if (!editing) {
      setEditTitle(task.title);
      setEditDesc(task.description ?? '');
    }
  }, [task.id, task.title, task.description, editing]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (editing) setEditing(false);
        else onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const lane = LANE_BY_ID[task.status];

  function cancelEdit() {
    setEditTitle(task.title);
    setEditDesc(task.description ?? '');
    setEditing(false);
  }
  function saveEdit() {
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) return;
    const updates: { title?: string; description?: string } = {};
    if (trimmedTitle !== task.title) updates.title = trimmedTitle;
    const newDesc = editDesc;
    if (newDesc !== (task.description ?? '')) updates.description = newDesc;
    if (Object.keys(updates).length > 0) onSave(updates);
    setEditing(false);
  }

  return (
    <div className="taskboard-overlay" onMouseDown={onClose}>
      <div
        className="taskboard-detail"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="taskboard-detail-head">
          <div
            className="taskboard-detail-stripe"
            style={{ background: lane.color }}
          />
          {editing ? (
            <input
              className="task-card-form-input taskboard-detail-title-input"
              value={editTitle}
              autoFocus
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
              }}
              placeholder="Title"
            />
          ) : (
            <div className="taskboard-detail-title">{task.title}</div>
          )}
          <button
            className="icon-btn sm"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="taskboard-detail-body">
          {editing ? (
            <textarea
              className="task-card-form-input task-card-form-textarea taskboard-detail-desc-input"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
              }}
              placeholder="Description"
              rows={6}
            />
          ) : task.description?.trim() ? (
            task.description
          ) : (
            <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
              No description.
            </span>
          )}
        </div>
        <div className="taskboard-detail-meta">
          <span>
            Status:{' '}
            <span style={{ color: lane.color, fontWeight: 600 }}>
              {lane.label}
            </span>
          </span>
          <span>Created: {new Date(task.createdAt).toLocaleString()}</span>
          {task.startedAt && (
            <span>Started: {new Date(task.startedAt).toLocaleString()}</span>
          )}
          {task.completedAt && (
            <span>Completed: {new Date(task.completedAt).toLocaleString()}</span>
          )}
          {task.branch && (
            <span>
              Branch: <code>{task.branch}</code>
            </span>
          )}
          {task.worktreePath && (
            <span>
              Worktree: <code>{task.worktreePath}</code>
            </span>
          )}
        </div>
        <div className="taskboard-detail-actions">
          {editing ? (
            <>
              <button
                className="btn-ghost"
                onClick={onDelete}
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 size={12} style={{ marginRight: 4 }} />
                Delete
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn-ghost" onClick={cancelEdit}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={saveEdit}
                disabled={!editTitle.trim()}
              >
                Save
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-ghost"
                onClick={onDelete}
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 size={12} style={{ marginRight: 4 }} />
                Delete
              </button>
              <span style={{ flex: 1 }} />
              {task.status !== 'backlog' && task.status !== 'in_progress' && task.status !== 'ready_to_merge' && (
                <button className="btn-ghost" onClick={() => onMove('backlog')}>
                  Move to Backlog
                </button>
              )}
              {task.status !== 'open' && (
                <button className="btn-ghost" onClick={() => onMove('open')}>
                  Move to Open
                </button>
              )}
              {task.status !== 'qa' && (
                <button className="btn-ghost" onClick={() => onMove('qa')}>
                  Mark QA
                </button>
              )}
              {task.status !== 'done' && (
                <button className="btn-ghost" onClick={() => onMove('done')}>
                  Mark Done
                </button>
              )}
              {onRun && (
                <button className="btn-primary" onClick={onRun}>
                  <Play size={11} fill="currentColor" style={{ marginRight: 4 }} />
                  Run
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskCard({
  task,
  laneColor,
  isDragging,
  onDragStart,
  onDragEnd,
  onDelete,
  onRun,
  onResume,
  onMerge,
  onView,
}: {
  task: Task;
  laneColor: string;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDelete: () => void;
  onRun?: () => void;
  onResume?: () => void;
  onMerge?: () => void;
  onView: () => void;
}) {
  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(DRAG_MIME, task.id);
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart();
  }

  const isConflict = !!task.conflict;

  return (
    <div
      className={`task-card ${isDragging ? 'dragging' : ''} ${
        isConflict ? 'conflict' : ''
      }`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      style={{ ['--lane-color' as string]: laneColor }}
    >
      <span className="task-card-grip" aria-hidden>
        <GripVertical size={12} />
      </span>
      <div
        className="task-card-body"
        onClick={onView}
        title="View task details"
      >
        <div className="task-card-title">
          {isConflict && (
            <span
              className="task-card-conflict-pill"
              title="Merge conflict — open the resolver"
            >
              <AlertTriangle size={10} /> conflict
            </span>
          )}
          {isConflict && task.conflictStartedAt && (
            <StuckPill since={task.conflictStartedAt} />
          )}
          {task.title}
        </div>
        {task.description && (
          <div className="task-card-desc">{task.description}</div>
        )}
      </div>
      <div className="task-card-actions">
        {onRun && (
          <button
            className="task-card-iconbtn play"
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
            title="Run in a new worktree with Claude"
            aria-label="Run task"
            draggable={false}
          >
            <Play size={11} fill="currentColor" />
          </button>
        )}
        {onResume && (
          <button
            className="task-card-iconbtn resume"
            onClick={(e) => {
              e.stopPropagation();
              onResume();
            }}
            title="Resume Claude in the existing worktree"
            aria-label="Resume task"
            draggable={false}
          >
            <Play size={11} fill="currentColor" />
          </button>
        )}
        {onMerge && (
          <button
            className={`task-card-iconbtn merge ${isConflict ? 'alert' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onMerge();
            }}
            title={
              isConflict
                ? 'Re-open conflict resolver Claude'
                : 'Merge worktree branch into this repo'
            }
            aria-label="Merge task"
            draggable={false}
          >
            {isConflict ? (
              <AlertTriangle size={12} />
            ) : (
              <GitMerge size={12} />
            )}
          </button>
        )}
        <button
          className="task-card-iconbtn danger"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete"
          aria-label="Delete task"
          draggable={false}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // Fallback for environments where clipboard API isn't available.
      const ta = document.createElement('textarea');
      ta.value = message;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing else to try */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="task-error-toast" role="alert">
      <span className="task-error-toast-icon" aria-hidden>
        <AlertTriangle size={14} />
      </span>
      <span className="task-error-toast-msg">{message}</span>
      <span className="task-error-toast-actions">
        <button
          className={`task-error-toast-btn ${copied ? 'copied' : ''}`}
          onClick={copy}
          title={copied ? 'Copied' : 'Copy message'}
          aria-label="Copy error message"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          className="task-error-toast-btn"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </span>
    </div>
  );
}

function MergeRunStrip({
  active,
  summary,
  tasks,
  onCancel,
  onDismiss,
}: {
  active: MergeRun | null;
  summary: MergeRun | null;
  tasks: Task[];
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (active) {
    const currentTask = active.current
      ? tasks.find((t) => t.id === active.current)
      : null;
    // Show 1-indexed position: if a task is actively running it counts as
    // the "current" task even though processed hasn't incremented yet.
    const currentPos = active.processed + (active.current ? 1 : 0);
    const pct =
      active.total > 0 ? Math.round((currentPos / active.total) * 100) : 0;
    return (
      <div className="merge-run-strip running" role="status">
        <span className="merge-run-strip-spinner" />
        <span className="merge-run-strip-text">
          Task {currentPos} of {active.total}
          {(active.merged.length > 0 ||
            active.conflicted.length > 0 ||
            active.errored.length > 0) && (
            <>
              {' '}
              ·{' '}
              {active.merged.length > 0 && (
                <span className="merge-run-stat ok">
                  {active.merged.length} merged
                </span>
              )}
              {active.conflicted.length > 0 && (
                <span className="merge-run-stat conflict">
                  {active.conflicted.length} conflict
                  {active.conflicted.length === 1 ? '' : 's'}
                </span>
              )}
              {active.errored.length > 0 && (
                <span className="merge-run-stat error">
                  {active.errored.length} error
                  {active.errored.length === 1 ? '' : 's'}
                </span>
              )}
            </>
          )}
          {currentTask && (
            <div className="merge-run-strip-current">
              {currentTask.title}
            </div>
          )}
        </span>
        <span className="merge-run-strip-pct">{pct}%</span>
        <button
          className="merge-run-strip-btn"
          onClick={onCancel}
          title="Cancel merge run"
          aria-label="Cancel merge run"
        >
          Cancel
        </button>
      </div>
    );
  }
  if (summary) {
    const isCancelled = summary.status === 'cancelled';
    return (
      <div
        className={`merge-run-strip done ${isCancelled ? 'cancelled' : ''}`}
        role="status"
      >
        <span className="merge-run-strip-text">
          {isCancelled ? 'Cancelled' : 'Merge run complete'} ·{' '}
          <span className="merge-run-stat ok">{summary.merged.length} merged</span>
          {summary.conflicted.length > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="merge-run-stat conflict">
                {summary.conflicted.length} conflict
                {summary.conflicted.length === 1 ? '' : 's'}
              </span>
            </>
          )}
          {summary.errored.length > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="merge-run-stat error">
                {summary.errored.length} error
                {summary.errored.length === 1 ? '' : 's'}
              </span>
            </>
          )}
        </span>
        <button
          className="merge-run-strip-btn"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    );
  }
  return null;
}

function StuckPill({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const minutes = Math.floor((now - since) / 60_000);
  // Only show after the resolver has had a fair shot to finish.
  if (minutes < 3) return null;
  const label = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
  return (
    <span
      className="task-card-stuck-pill"
      title={`Resolver has been working for ${label} — may be stuck`}
    >
      stuck {label}
    </span>
  );
}
