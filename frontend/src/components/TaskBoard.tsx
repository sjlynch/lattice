import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Kanban,
  Plus,
  Trash2,
  GripVertical,
  Play,
  X,
  GitMerge,
  AlertTriangle,
  Pencil,
} from 'lucide-react';
import { FloatingPanel } from './FloatingPanel';
import { useTerminals } from '../TerminalsContext';
import {
  createTask as apiCreateTask,
  deleteTask as apiDeleteTask,
  fetchTasks,
  mergeTask as apiMergeTask,
  runTask as apiRunTask,
  subscribeTasks,
  updateTask as apiUpdateTask,
  type Task,
  type TaskStatus,
} from '../api';

const LANES: { id: TaskStatus; label: string; color: string }[] = [
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

  // Filter state — all lanes visible by default.
  const [visibleLanes, setVisibleLanes] = useState<Set<TaskStatus>>(
    () => new Set(LANES.map((l) => l.id)),
  );

  const { addTerminal } = useTerminals();

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
      const res = await apiRunTask(task.id);
      addTerminal({
        label: shortLabel(task.title),
        cwd: res.worktreePath,
        initialCommand: res.command,
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

  async function mergeTaskAction(task: Task): Promise<boolean> {
    try {
      const res = await apiMergeTask(task.id);
      if (res.merged) return true;
      // Conflict: spawn the resolver Claude in the main repo.
      addTerminal({
        label: `merge:${shortLabel(task.title)}`,
        cwd: res.cwd,
        initialCommand: res.command,
      });
      return false;
    } catch (err) {
      showError(`Merge failed: ${(err as Error).message}`);
      return false;
    }
  }

  async function mergeAllReady() {
    const ready = tasks
      .filter((t) => t.status === 'ready_to_merge' && !t.conflict)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of ready) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await mergeTaskAction(t);
      if (!ok) break; // stop on first conflict so the user can deal with it
    }
  }

  const grouped = useMemo(() => {
    const m: Record<TaskStatus, Task[]> = {
      open: [],
      in_progress: [],
      ready_to_merge: [],
      qa: [],
      done: [],
      deleted: [],
    };
    for (const t of tasks) m[t.status].push(t);
    for (const k of Object.keys(m) as TaskStatus[]) {
      m[k].sort((a, b) => b.createdAt - a.createdAt);
    }
    return m;
  }, [tasks]);

  const activeCount = tasks.filter(
    (t) => t.status !== 'deleted' && t.status !== 'done',
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
                onDelete={deleteTask}
                onRun={runTask}
                onMerge={mergeTaskAction}
                onRunAll={
                  lane.id === 'open'
                    ? runAllOpen
                    : lane.id === 'ready_to_merge'
                    ? mergeAllReady
                    : undefined
                }
                onView={setViewing}
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
          {error && <div className="task-error-toast">{error}</div>}
        </div>
        <div className="taskboard-footer">
          {tasks.length} total · drag a task between lanes to move it · click a
          card to view
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
  onDelete,
  onRun,
  onMerge,
  onRunAll,
  onView,
}: {
  lane: (typeof LANES)[number];
  tasks: Task[];
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onAdd: () => void;
  onMove: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onRun: (task: Task) => void;
  onMerge: (task: Task) => Promise<boolean>;
  onRunAll?: () => void;
  onView: (task: Task) => void;
}) {
  const [isOver, setIsOver] = useState(false);

  function onDragOver(e: React.DragEvent) {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isOver) setIsOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsOver(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const id =
      e.dataTransfer.getData(DRAG_MIME) ||
      e.dataTransfer.getData('text/plain');
    if (id) onMove(id, lane.id);
    setIsOver(false);
  }

  return (
    <div
      className={`taskboard-lane ${isOver ? 'drop-target' : ''}`}
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
              className={`lane-runall ${lane.id === 'ready_to_merge' ? 'merge' : ''}`}
              onClick={onRunAll}
              disabled={tasks.length === 0}
              title={
                lane.id === 'ready_to_merge'
                  ? 'Merge every Ready-to-Merge task (stops on first conflict)'
                  : 'Run every task in Open in a new worktree'
              }
              aria-label={
                lane.id === 'ready_to_merge'
                  ? 'Merge all ready tasks'
                  : 'Run all open tasks'
              }
            >
              {lane.id === 'ready_to_merge' ? (
                <GitMerge size={11} />
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
      <div className="taskboard-lane-track">
        {tasks.length === 0 ? (
          <div className="taskboard-lane-empty">
            {isOver ? 'Drop here' : 'No tasks'}
          </div>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              laneColor={lane.color}
              isDragging={draggingId === t.id}
              onDragStart={() => onDragStart(t.id)}
              onDragEnd={onDragEnd}
              onDelete={() => onDelete(t.id)}
              onRun={lane.id === 'open' ? () => onRun(t) : undefined}
              onMerge={
                lane.id === 'ready_to_merge' ? () => onMerge(t) : undefined
              }
              onView={() => onView(t)}
            />
          ))
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
  const [editing, setEditing] = useState(false);
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

  function startEdit() {
    setEditTitle(task.title);
    setEditDesc(task.description ?? '');
    setEditing(true);
  }
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
          {!editing && (
            <button
              className="icon-btn sm"
              onClick={startEdit}
              aria-label="Edit task"
              title="Edit"
            >
              <Pencil size={13} />
            </button>
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
