import type { DragEvent, MouseEvent } from 'react';
import { GripVertical } from 'lucide-react';
import type { Task } from '../../api';
import { taskColor } from '../../taskColors';
import { DRAG_MIME } from './lanes';
import {
  ACCENT_STATUSES,
  getSelectionClickIntent,
  getTaskDragPayloadIds,
} from './TaskCardSelection';
import {
  TaskCardActions,
  TaskCardBody,
} from './TaskCardSubcomponents';

// Re-exported here so existing importers keep a stable surface even though the
// implementations now live in the focused TaskCard* modules.
export {
  getSelectionClickIntent,
  getTaskDragPayloadIds,
} from './TaskCardSelection';
export type {
  SelectionClickIntent,
  SelectionClickModifiers,
} from './TaskCardSelection';

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
  // Distinct per-task accent for the active lanes — same color the task's
  // Claude node / worktree rings use on the graph.
  const accentColor = ACCENT_STATUSES.has(task.status) ? taskColor(task) : null;

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
      } ${isSelected ? 'selected' : ''} ${accentColor ? 'has-task-accent' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      style={{
        ['--lane-color' as string]: laneColor,
        ...(accentColor ? { ['--task-color' as string]: accentColor } : {}),
      }}
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
