import { memo } from 'react';
import { AlertTriangle, Hourglass } from 'lucide-react';
import type { Task } from '../../api';
import { StuckPill } from './StuckPill';
import {
  buildTaskCardActions,
  type TaskCardActionHandlers,
} from './TaskCardActions';

// Flatten the (possibly multi-line, `---`-divided) summary into a single
// line for the card preview. The full text is in the title tooltip and the
// detail overlay; here we just want a readable one-liner.
function summaryPreview(summary: string): string {
  return clipPreview(
    summary
      .replace(/\n?-{3,}\n?/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

// Cards only ever show one clipped line, but a description with agent-appended
// summaries can run to tens of KB — rendering all of it as text AND again in
// the `title` tooltip for every card is pure waste (and a giant tooltip). Keep
// a short preview here; the detail overlay shows the full text.
const CARD_PREVIEW_CHARS = 300;

function clipPreview(text: string): string {
  return text.length > CARD_PREVIEW_CHARS
    ? `${text.slice(0, CARD_PREVIEW_CHARS).trimEnd()}…`
    : text;
}

// Title/description block plus the queued/conflict pills. The click handler
// lives on the parent card container now (a plain click opens the editor;
// ctrl/shift+click multi-select), so the body is purely presentational.
// Memoized: re-renders driven by unrelated card state (e.g. drag highlight)
// skip the body.
export const TaskCardBody = memo(function TaskCardBody({
  task,
  isConflict,
  isSelected,
  onOpenResolver,
}: {
  task: Task;
  isConflict: boolean;
  isSelected: boolean;
  // When set, the conflict pill becomes a button that re-opens the resolver
  // (same handler as the merge-under-conflict button).
  onOpenResolver?: () => void;
}) {
  return (
    <div
      className="task-card-body"
      title={
        isSelected
          ? 'Click to edit · ctrl+click to deselect · shift+click to range-select'
          : 'Click to edit · ctrl+click or shift+click to multi-select'
      }
    >
      <div className="task-card-title" title={task.title}>
        <TaskCardConflictBadges
          task={task}
          isConflict={isConflict}
          onOpenResolver={onOpenResolver}
        />
        {task.runQueued && (
          <span
            className="task-card-queued-pill"
            title={
              task.runWaitingForDisk
                ? `Waiting for disk space — ${task.runWaitingForDisk}`
                : 'Waiting for a free agent slot — runs automatically when one frees up'
            }
          >
            <Hourglass size={9} /> {task.runWaitingForDisk ? 'waiting for disk' : 'queued'}
          </span>
        )}
        {task.title}
      </div>
      {task.description && (
        <div className="task-card-desc" title={clipPreview(task.description)}>
          {clipPreview(task.description)}
        </div>
      )}
      {task.summary && (
        <div className="task-card-summary" title={clipPreview(task.summary)}>
          <span className="task-card-summary-label">summary</span>
          {summaryPreview(task.summary)}
        </div>
      )}
    </div>
  );
});

// Conflict pill + (once it's been stuck a while) the "stuck Nm" pill. Renders
// nothing unless the task is mid-conflict.
export const TaskCardConflictBadges = memo(function TaskCardConflictBadges({
  task,
  isConflict,
  onOpenResolver,
}: {
  task: Task;
  isConflict: boolean;
  // When supplied, the pill is the most salient one-click entry point to the
  // conflict resolver — same handler the merge-under-conflict button uses.
  onOpenResolver?: () => void;
}) {
  if (!isConflict) return null;
  return (
    <>
      {onOpenResolver ? (
        <button
          type="button"
          className="task-card-conflict-pill"
          title="Open conflict resolver"
          aria-label="Open conflict resolver"
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            onOpenResolver();
          }}
        >
          <AlertTriangle size={10} /> conflict
        </button>
      ) : (
        <span
          className="task-card-conflict-pill"
          title="Merge conflict — open the resolver"
        >
          <AlertTriangle size={10} /> conflict
        </span>
      )}
      {task.conflictStartedAt && <StuckPill since={task.conflictStartedAt} />}
    </>
  );
});

// The lane-appropriate icon button row. The set + order of buttons is derived
// declaratively from which handlers are present (see `buildTaskCardActions`).
// Memoized: TaskCard passes stable, useCallback-wrapped handlers so the row
// skips re-rendering when only drag/selection state on the card changes.
export const TaskCardActions = memo(function TaskCardActions({
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
});
