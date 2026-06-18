import { memo, useCallback, useMemo, type DragEvent, type MouseEvent } from 'react';
import { GripVertical } from 'lucide-react';
import type { Task, TaskStatus } from '../../api';
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

// A task can be run from scratch (▶ creates a fresh worktree + agent) when it
// is an Open task, or an In Progress task that has no worktree yet — i.e. it
// was dragged into the lane manually and never actually started. The latter
// otherwise had no runnable button (resume needs an existing worktree), so the
// only way to start it was to drag it back to Open first. Lives here (was in
// Lane) so the per-card action gating moves into the memoized card.
function canRunFresh(laneId: TaskStatus, task: Task): boolean {
  if (laneId === 'open') return true;
  return laneId === 'in_progress' && !task.worktreePath;
}

// The card takes id/task-parameterized callbacks and forwards the already
// useCallback-stable launcher handlers verbatim (gating + the per-task focus
// lookup happen inside this component). That stable prop contract is what lets
// React.memo skip cards whose task is untouched on a /ws/tasks tick.
export type TaskCardProps = {
  task: Task;
  laneId: TaskStatus;
  laneColor: string;
  isDragging: boolean;
  isSelected: boolean;
  selectedIdsInLane: string[];
  getFocusTerminal?: (task: Task) => (() => void) | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDelete: (id: string) => void;
  onRun: (task: Task) => void;
  onCancelQueuedRun: (task: Task) => void;
  onResume: (task: Task) => void;
  onMerge: (task: Task) => void | Promise<boolean>;
  // Present only for QA-lane cards when the Playwright MCP is on; launches a
  // full end-to-end test of this merged task.
  onQaRun?: (task: Task) => void;
  onView: (task: Task) => void;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onRangeSelect: (id: string) => void;
};

// One row in a lane. Shows the task title/description, a conflict pill if
// the task is in conflict-resolution, and lane-appropriate action buttons
// (run/resume/merge/delete). Click anywhere on the body to highlight that
// task (single-select); Ctrl/Cmd+click toggles multi-select; Shift+click
// range-selects. The pencil icon opens the detail overlay.
export const TaskCard = memo(function TaskCard({
  task,
  laneId,
  laneColor,
  isDragging,
  isSelected,
  selectedIdsInLane,
  getFocusTerminal,
  onDragStart,
  onDragEnd,
  onDelete,
  onRun,
  onCancelQueuedRun,
  onResume,
  onMerge,
  onQaRun,
  onView,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: TaskCardProps) {
  const isConflict = !!task.conflict;
  // Distinct per-task accent for the active lanes — same color the task's
  // Claude node / worktree rings use on the graph.
  const accentColor = ACCENT_STATUSES.has(task.status) ? taskColor(task) : null;

  const handleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const ids = getTaskDragPayloadIds(task.id, isSelected, selectedIdsInLane);
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
      e.dataTransfer.setData('text/plain', task.id);
      e.dataTransfer.effectAllowed = 'move';
      onDragStart(task.id);
    },
    [task.id, isSelected, selectedIdsInLane, onDragStart],
  );

  const handleBodyClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const intent = getSelectionClickIntent(e);
      if (intent === 'toggle') onToggleSelect(task.id);
      else if (intent === 'range') onRangeSelect(task.id);
      else onSelect(task.id);
    },
    [task.id, onSelect, onToggleSelect, onRangeSelect],
  );

  // Stable per-action closures fed to the memoized action row. Each depends
  // only on the (stable) launcher handler + this card's task, so re-renders
  // driven by drag/selection state don't churn the action buttons.
  const handleDelete = useCallback(() => onDelete(task.id), [onDelete, task.id]);
  const handleView = useCallback(() => onView(task), [onView, task]);
  const handleRun = useCallback(() => onRun(task), [onRun, task]);
  const handleCancelQueuedRun = useCallback(
    () => onCancelQueuedRun(task),
    [onCancelQueuedRun, task],
  );
  const handleResume = useCallback(() => onResume(task), [onResume, task]);
  const handleMerge = useCallback(() => onMerge(task), [onMerge, task]);
  const handleQaRun = useCallback(() => onQaRun?.(task), [onQaRun, task]);

  // Per-card terminal-focus lookup (was done in Lane). Memoized so the
  // resolved handler is referentially stable until the task/mapping changes.
  const focusTerminal = useMemo(
    () => getFocusTerminal?.(task) ?? undefined,
    [getFocusTerminal, task],
  );

  const canRun = canRunFresh(laneId, task);

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
        onDelete={handleDelete}
        onRun={canRun && !task.runQueued ? handleRun : undefined}
        onCancelQueuedRun={
          canRun && task.runQueued ? handleCancelQueuedRun : undefined
        }
        onResume={
          laneId === 'in_progress' && task.worktreePath
            ? handleResume
            : undefined
        }
        onMerge={laneId === 'ready_to_merge' ? handleMerge : undefined}
        onQaRun={onQaRun ? handleQaRun : undefined}
        onFocusTerminal={focusTerminal}
        onView={handleView}
      />
    </div>
  );
});
