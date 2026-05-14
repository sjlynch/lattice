import { useEffect, useState } from 'react';
import { Play, Trash2, X } from 'lucide-react';
import type { Task, TaskStatus } from '../../api';
import { LANE_BY_ID, type Lane } from './lanes';

type MoveTarget = {
  status: TaskStatus;
  label: string;
  shouldShow: (status: TaskStatus) => boolean;
};

const MOVE_TARGETS: MoveTarget[] = [
  {
    status: 'backlog',
    label: 'Move to Backlog',
    shouldShow: (status) =>
      status !== 'backlog' &&
      status !== 'in_progress' &&
      status !== 'ready_to_merge',
  },
  {
    status: 'open',
    label: 'Move to Open',
    shouldShow: (status) => status !== 'open',
  },
  {
    status: 'qa',
    label: 'Mark QA',
    shouldShow: (status) => status !== 'qa',
  },
  {
    status: 'done',
    label: 'Mark Done',
    shouldShow: (status) => status !== 'done',
  },
];

type TaskDetailMetaProps = {
  task: Task;
  lane: Lane;
};

function TaskDetailMeta({ task, lane }: TaskDetailMetaProps) {
  return (
    <div className="taskboard-detail-meta">
      <span>
        Status:{' '}
        <span style={{ color: lane.color, fontWeight: 600 }}>{lane.label}</span>
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
  );
}

type TaskDetailActionsProps = {
  task: Task;
  editing: boolean;
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onMove: (status: TaskStatus) => void;
  onRun?: () => void;
};

function TaskDetailActions({
  task,
  editing,
  canSave,
  onSave,
  onCancel,
  onDelete,
  onMove,
  onRun,
}: TaskDetailActionsProps) {
  return (
    <div className="taskboard-detail-actions">
      <button
        className="btn-ghost"
        onClick={onDelete}
        style={{ color: 'var(--danger)' }}
      >
        <Trash2 size={12} style={{ marginRight: 4 }} />
        Delete
      </button>
      <span style={{ flex: 1 }} />
      {editing ? (
        <>
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" onClick={onSave} disabled={!canSave}>
            Save
          </button>
        </>
      ) : (
        <>
          {MOVE_TARGETS.filter((target) =>
            target.shouldShow(task.status),
          ).map((target) => (
            <button
              key={target.status}
              className="btn-ghost"
              onClick={() => onMove(target.status)}
            >
              {target.label}
            </button>
          ))}
          {onRun && (
            <button className="btn-primary" onClick={onRun}>
              <Play size={11} fill="currentColor" style={{ marginRight: 4 }} />
              Run
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Detail/edit overlay for a single task. Edit mode is on by default so the
// title input takes focus; cancel reverts edits, save patches the task.
// Action row at the bottom shifts based on the task's current lane —
// shows only the moves that make sense.
export function TaskDetailOverlay({
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

  const titleSlot = editing ? (
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
  );

  const bodySlot = editing ? (
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
  );

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
          {titleSlot}
          <button
            className="icon-btn sm"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="taskboard-detail-body">{bodySlot}</div>
        <TaskDetailMeta task={task} lane={lane} />
        <TaskDetailActions
          task={task}
          editing={editing}
          canSave={Boolean(editTitle.trim())}
          onSave={saveEdit}
          onCancel={cancelEdit}
          onDelete={onDelete}
          onMove={onMove}
          onRun={onRun}
        />
      </div>
    </div>
  );
}
