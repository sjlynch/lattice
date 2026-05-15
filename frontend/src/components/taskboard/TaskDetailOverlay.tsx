import { useEffect, useRef, useState } from 'react';
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

// Detail overlay for a single task. Title and description are always editable;
// the Save button enables once a field is dirty. Lane-appropriate Move/Run
// buttons sit alongside Save so the same modal handles both viewing and
// editing.
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
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description ?? '');

  // Reset fields only when the modal switches to a different task — preserve
  // in-flight edits through WS updates to this same task.
  const lastTaskIdRef = useRef(task.id);
  useEffect(() => {
    if (lastTaskIdRef.current !== task.id) {
      lastTaskIdRef.current = task.id;
      setEditTitle(task.title);
      setEditDesc(task.description ?? '');
    }
  }, [task.id, task.title, task.description]);

  const lane = LANE_BY_ID[task.status];
  const trimmedTitle = editTitle.trim();
  const titleChanged = trimmedTitle !== task.title;
  const descChanged = editDesc !== (task.description ?? '');
  const dirty = (titleChanged && trimmedTitle.length > 0) || descChanged;

  function saveEdit() {
    if (!dirty) return;
    const updates: { title?: string; description?: string } = {};
    if (titleChanged && trimmedTitle.length > 0) updates.title = trimmedTitle;
    if (descChanged) updates.description = editDesc;
    if (Object.keys(updates).length > 0) onSave(updates);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const moveTargets = MOVE_TARGETS.filter((target) =>
    target.shouldShow(task.status),
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
          <textarea
            className="task-card-form-input task-card-form-textarea taskboard-detail-desc-input"
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
            }}
            placeholder="Description"
          />
        </div>
        <TaskDetailMeta task={task} lane={lane} />
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
          {moveTargets.map((target) => (
            <button
              key={target.status}
              className="btn-ghost"
              onClick={() => onMove(target.status)}
            >
              {target.label}
            </button>
          ))}
          {onRun && (
            <button className="btn-ghost" onClick={onRun}>
              <Play size={11} fill="currentColor" style={{ marginRight: 4 }} />
              Run
            </button>
          )}
          <button
            className="btn-primary"
            onClick={saveEdit}
            disabled={!dirty}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
