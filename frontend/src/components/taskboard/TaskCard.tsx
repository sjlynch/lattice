import type { DragEvent, MouseEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  Ban,
  GitMerge,
  GripVertical,
  Hourglass,
  Pencil,
  Play,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import type { Task } from '../../api';
import { DRAG_MIME } from './lanes';
import { StuckPill } from './StuckPill';

export type SelectionClickIntent = 'select' | 'toggle' | 'range';

export type SelectionClickModifiers = {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export type TaskCardProps = {
  task: Task;
  laneColor: string;
  isDragging: boolean;
  isSelected: boolean;
  selectedIdsInLane: string[];
  onDragStart: () => void;
  onDragEnd: () => void;
  onDelete: () => void;
  onRun?: () => void;
  onCancelQueuedRun?: () => void;
  onResume?: () => void;
  onMerge?: () => void;
  onFocusTerminal?: () => void;
  onView: () => void;
  onSelect: () => void;
  onToggleSelect: () => void;
  onRangeSelect: () => void;
};

export function getTaskDragPayloadIds(
  taskId: string,
  isSelected: boolean,
  selectedIdsInLane: readonly string[],
): string[] {
  return isSelected ? Array.from(selectedIdsInLane) : [taskId];
}

export function getSelectionClickIntent({
  ctrlKey,
  metaKey,
  shiftKey,
}: SelectionClickModifiers): SelectionClickIntent {
  if (ctrlKey || metaKey) return 'toggle';
  if (shiftKey) return 'range';
  return 'select';
}

// One row in a lane. Shows the task title/description, a conflict pill if
// the task is in conflict-resolution, and lane-appropriate action buttons
// (run/resume/merge/delete). Click anywhere on the body to highlight that
// task (single-select); Ctrl/Cmd+click toggles multi-select; Shift+click
// range-selects. The pencil icon opens the detail overlay.
export function TaskCard({
  task,
  laneColor,
  isDragging,
  isSelected,
  selectedIdsInLane,
  onDragStart,
  onDragEnd,
  onDelete,
  onRun,
  onCancelQueuedRun,
  onResume,
  onMerge,
  onFocusTerminal,
  onView,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: TaskCardProps) {
  const isConflict = !!task.conflict;

  function handleDragStart(e: DragEvent<HTMLDivElement>) {
    const ids = getTaskDragPayloadIds(
      task.id,
      isSelected,
      selectedIdsInLane,
    );
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart();
  }

  function handleBodyClick(e: MouseEvent<HTMLDivElement>) {
    const intent = getSelectionClickIntent(e);
    if (intent === 'toggle') {
      onToggleSelect();
    } else if (intent === 'range') {
      onRangeSelect();
    } else {
      onSelect();
    }
  }

  return (
    <div
      className={`task-card ${isDragging ? 'dragging' : ''} ${
        isConflict ? 'conflict' : ''
      } ${isSelected ? 'selected' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      style={{ ['--lane-color' as string]: laneColor }}
    >
      <span className="task-card-grip" aria-hidden>
        <GripVertical size={12} />
      </span>
      <TaskCardBody
        task={task}
        isConflict={isConflict}
        isSelected={isSelected}
        onClick={handleBodyClick}
      />
      <TaskCardActions
        isConflict={isConflict}
        onDelete={onDelete}
        onRun={onRun}
        onCancelQueuedRun={onCancelQueuedRun}
        onResume={onResume}
        onMerge={onMerge}
        onFocusTerminal={onFocusTerminal}
        onView={onView}
      />
    </div>
  );
}

function TaskCardBody({
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

function TaskCardConflictBadges({
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

type TaskCardAction = {
  key: string;
  className: string;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  icon: ReactNode;
};

function TaskCardActions({
  isConflict,
  onDelete,
  onRun,
  onCancelQueuedRun,
  onResume,
  onMerge,
  onFocusTerminal,
  onView,
}: Pick<
  TaskCardProps,
  | 'onDelete'
  | 'onRun'
  | 'onCancelQueuedRun'
  | 'onResume'
  | 'onMerge'
  | 'onFocusTerminal'
  | 'onView'
> & {
  isConflict: boolean;
}) {
  const actions: TaskCardAction[] = [];

  if (onFocusTerminal) {
    actions.push({
      key: 'terminal',
      className: 'task-card-iconbtn terminal',
      onClick: onFocusTerminal,
      title: "Focus this task's terminal",
      ariaLabel: 'Focus task terminal',
      icon: <TerminalSquare size={12} />,
    });
  }

  if (onRun) {
    actions.push({
      key: 'run',
      className: 'task-card-iconbtn play',
      onClick: onRun,
      title: 'Run in a new worktree with Claude',
      ariaLabel: 'Run task',
      icon: <Play size={11} fill="currentColor" />,
    });
  }

  if (onCancelQueuedRun) {
    actions.push({
      key: 'cancel-queued',
      className: 'task-card-iconbtn cancel-queued',
      onClick: onCancelQueuedRun,
      title: 'Cancel queued run — drop back to Open',
      ariaLabel: 'Cancel queued run',
      icon: <Ban size={12} />,
    });
  }

  if (onResume) {
    actions.push({
      key: 'resume',
      className: 'task-card-iconbtn resume',
      onClick: onResume,
      title: 'Resume Claude in the existing worktree',
      ariaLabel: 'Resume task',
      icon: <Play size={11} fill="currentColor" />,
    });
  }

  if (onMerge) {
    actions.push({
      key: 'merge',
      className: `task-card-iconbtn merge ${isConflict ? 'alert' : ''}`,
      onClick: onMerge,
      title: isConflict
        ? 'Re-open conflict resolver Claude'
        : 'Merge worktree branch into this repo',
      ariaLabel: 'Merge task',
      icon: isConflict ? <AlertTriangle size={12} /> : <GitMerge size={12} />,
    });
  }

  actions.push(
    {
      key: 'edit',
      className: 'task-card-iconbtn edit',
      onClick: onView,
      title: 'View / edit task',
      ariaLabel: 'View task details',
      icon: <Pencil size={11} />,
    },
    {
      key: 'delete',
      className: 'task-card-iconbtn danger',
      onClick: onDelete,
      title: 'Delete',
      ariaLabel: 'Delete task',
      icon: <Trash2 size={12} />,
    },
  );

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
