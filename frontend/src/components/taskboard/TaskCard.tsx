import {
  AlertTriangle,
  GitMerge,
  GripVertical,
  Play,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import type { Task } from '../../api';
import { DRAG_MIME } from './lanes';
import { StuckPill } from './StuckPill';

// One row in a lane. Shows the task title/description, a conflict pill if
// the task is in conflict-resolution, and lane-appropriate action buttons
// (run/resume/merge/delete). Click anywhere on the body to open the
// detail overlay.
export function TaskCard({
  task,
  laneColor,
  isDragging,
  onDragStart,
  onDragEnd,
  onDelete,
  onRun,
  onResume,
  onMerge,
  onFocusTerminal,
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
  onFocusTerminal?: () => void;
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
        {onFocusTerminal && (
          <button
            className="task-card-iconbtn terminal"
            onClick={(e) => {
              e.stopPropagation();
              onFocusTerminal();
            }}
            title="Focus this task's terminal"
            aria-label="Focus task terminal"
            draggable={false}
          >
            <TerminalSquare size={12} />
          </button>
        )}
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
