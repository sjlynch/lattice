import type { MouseEvent } from 'react';
import { AlertTriangle, Hourglass } from 'lucide-react';
import type { Task } from '../../api';
import { StuckPill } from './StuckPill';
import {
  buildTaskCardActions,
  type TaskCardActionHandlers,
} from './TaskCardActions';

// Title/description block plus the queued/conflict pills. Click anywhere on
// the body to drive selection (handled by the parent via `onClick`).
export function TaskCardBody({
  task,
  isConflict,
  isSelected,
  onClick,
}: {
  task: Task;
  isConflict: boolean;
  isSelected: boolean;
  onClick: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className="task-card-body"
      onClick={onClick}
      title={
        isSelected
          ? 'Ctrl+click to deselect · shift+click to range-select'
          : 'Click to select · ctrl+click to multi-select'
      }
    >
      <div className="task-card-title">
        <TaskCardConflictBadges task={task} isConflict={isConflict} />
        {task.runQueued && (
          <span
            className="task-card-queued-pill"
            title="Waiting for a free agent slot — runs automatically when one frees up"
          >
            <Hourglass size={9} /> queued
          </span>
        )}
        {task.title}
      </div>
      {task.description && (
        <div className="task-card-desc">{task.description}</div>
      )}
    </div>
  );
}

// Conflict pill + (once it's been stuck a while) the "stuck Nm" pill. Renders
// nothing unless the task is mid-conflict.
export function TaskCardConflictBadges({
  task,
  isConflict,
}: {
  task: Task;
  isConflict: boolean;
}) {
  if (!isConflict) return null;
  return (
    <>
      <span
        className="task-card-conflict-pill"
        title="Merge conflict — open the resolver"
      >
        <AlertTriangle size={10} /> conflict
      </span>
      {task.conflictStartedAt && <StuckPill since={task.conflictStartedAt} />}
    </>
  );
}

// The lane-appropriate icon button row. The set + order of buttons is derived
// declaratively from which handlers are present (see `buildTaskCardActions`).
export function TaskCardActions({
  isConflict,
  ...handlers
}: TaskCardActionHandlers & { isConflict: boolean }) {
  const actions = buildTaskCardActions(handlers, { isConflict });

  return (
    <div className="task-card-actions">
      {actions.map((action) => (
        <button
          key={action.key}
          className={action.className}
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
          title={action.title}
          aria-label={action.ariaLabel}
          draggable={false}
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}
