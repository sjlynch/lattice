import { useEffect } from 'react';
import { Play, Trash2, X } from 'lucide-react';
import type { Task, TaskStatus } from '../../api';
import { LANE_BY_ID } from './lanes';
import { getApplicableMoveTargets } from './moveTargets';
import { TaskDetailMeta } from './TaskDetailMeta';
import { useTaskDetailEdit } from './hooks/useTaskDetailEdit';
import { useFocusTrap } from '../../hooks/useFocusTrap';

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
  const { editTitle, setEditTitle, editDesc, setEditDesc, dirty, prepareSave } =
    useTaskDetailEdit(task);
  // Mounted only while open, so the trap is always active here.
  const dialogRef = useFocusTrap<HTMLDivElement>(true);

  const lane = LANE_BY_ID[task.status];

  function saveEdit() {
    const updates = prepareSave();
    if (updates) onSave(updates);
    // Saving closes the overlay — clicking Save (or pressing Enter) is a
    // "done editing" gesture, so dismiss rather than leaving it open.
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const moveTargets = getApplicableMoveTargets(task.status);

  return (
    <div className="taskboard-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="taskboard-detail"
        role="dialog"
        aria-modal="true"
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
        {task.summary && (
          <div className="taskboard-detail-summary">
            <div className="taskboard-detail-summary-label">Summary / updates</div>
            <div className="taskboard-detail-summary-text">{task.summary}</div>
          </div>
        )}
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
          <span
            className="taskboard-detail-current"
            aria-current="true"
            title={`This task is currently in ${lane.label}`}
          >
            Currently:
            <span
              className="taskboard-detail-current-dot"
              style={{ background: lane.color }}
            />
            <strong style={{ color: lane.color }}>{lane.label}</strong>
          </span>
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
