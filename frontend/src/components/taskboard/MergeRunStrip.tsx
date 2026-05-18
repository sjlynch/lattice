import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MergeRun, MergeRunErrorEntry, Task } from '../../api';
import type { Lane as LaneDef } from './lanes';

// Build a multi-line tooltip listing per-task merge errors, resolving
// each taskId to its title (falls back to a short id). Used by the
// "N errors" chip — hovering reveals what actually went wrong.
function buildErrorsTooltip(
  entries: MergeRunErrorEntry[],
  tasks: Task[],
): string {
  return entries
    .map((entry) => {
      const task = tasks.find((t) => t.id === entry.taskId);
      const label = task?.title?.trim() || entry.taskId.slice(-6);
      return `${label}: ${entry.error}`;
    })
    .join('\n');
}

export function mergeRunStripFor(
  lane: LaneDef,
  laneTasks: Task[],
  mergeRun: MergeRun | null,
  recentRunSummary: MergeRun | null,
  tasks: Task[],
  onCancel: () => void,
  onDismiss: () => void,
): ReactNode | undefined {
  if (lane.id !== 'ready_to_merge') return undefined;
  const hasConflicts = laneTasks.some((task) => task.conflict);
  if (!mergeRun && !recentRunSummary && !hasConflicts) return undefined;
  return (
    <MergeRunStrip
      active={mergeRun}
      summary={recentRunSummary}
      tasks={tasks}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />
  );
}

// Progress strip rendered above the Ready-to-Merge lane during a backend
// merge run. Priority order:
//   1. active run → spinner with task progress
//   2. pending conflicts (resolver Claude still running) → spinner "resolving"
//   3. completed run summary → dismissable result line
export function MergeRunStrip({
  active,
  summary,
  tasks,
  onCancel,
  onDismiss,
}: {
  active: MergeRun | null;
  summary: MergeRun | null;
  tasks: Task[];
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const pendingConflicts = tasks.filter((t) => t.conflict);
  if (active) return <ActiveStrip run={active} tasks={tasks} onCancel={onCancel} />;
  if (pendingConflicts.length > 0) return <ResolvingStrip conflicts={pendingConflicts} />;
  if (summary) return <SummaryStrip run={summary} tasks={tasks} onDismiss={onDismiss} />;
  return null;
}

function ActiveStrip({
  run,
  tasks,
  onCancel,
}: {
  run: MergeRun;
  tasks: Task[];
  onCancel: () => void;
}) {
  const currentTask = run.current
    ? tasks.find((t) => t.id === run.current)
    : null;
  // Show 1-indexed position: if a task is actively running it counts as
  // the "current" task even though processed hasn't incremented yet.
  const currentPos = run.processed + (run.current ? 1 : 0);
  const pct = run.total > 0 ? Math.round((currentPos / run.total) * 100) : 0;
  const hasStats =
    run.merged.length > 0 ||
    run.conflicted.length > 0 ||
    run.errored.length > 0;
  return (
    <div className="merge-run-strip running" role="status">
      <span className="merge-run-strip-spinner" />
      <span className="merge-run-strip-text">
        Task {currentPos} of {run.total}
        {hasStats && (
          <>
            {' '}·{' '}
            {run.merged.length > 0 && (
              <span className="merge-run-stat ok">{run.merged.length} merged</span>
            )}
            {run.conflicted.length > 0 && (
              <span className="merge-run-stat conflict">
                {run.conflicted.length} conflict
                {run.conflicted.length === 1 ? '' : 's'}
              </span>
            )}
            {run.errored.length > 0 && (
              <span
                className="merge-run-stat error"
                title={buildErrorsTooltip(run.errored, tasks)}
              >
                {run.errored.length} error
                {run.errored.length === 1 ? '' : 's'}
              </span>
            )}
          </>
        )}
        {currentTask && (
          <div className="merge-run-strip-current">{currentTask.title}</div>
        )}
      </span>
      <span className="merge-run-strip-pct">{pct}%</span>
      <button
        className="merge-run-strip-btn"
        onClick={onCancel}
        title="Cancel merge run"
        aria-label="Cancel merge run"
      >
        Cancel
      </button>
    </div>
  );
}

function ResolvingStrip({ conflicts }: { conflicts: Task[] }) {
  const first = conflicts[0];
  const extra = conflicts.length - 1;
  return (
    <div className="merge-run-strip running" role="status">
      <span className="merge-run-strip-spinner" />
      <span className="merge-run-strip-text">
        Resolving{' '}
        <span className="merge-run-stat conflict">
          {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}
        </span>
        <div className="merge-run-strip-current">
          {first.title}
          {extra > 0 && ` + ${extra} more`}
        </div>
      </span>
    </div>
  );
}

function SummaryStrip({
  run,
  tasks,
  onDismiss,
}: {
  run: MergeRun;
  tasks: Task[];
  onDismiss: () => void;
}) {
  const isCancelled = run.status === 'cancelled';
  return (
    <div
      className={`merge-run-strip done ${isCancelled ? 'cancelled' : ''}`}
      role="status"
    >
      <span className="merge-run-strip-text">
        {isCancelled ? 'Cancelled' : 'Merge run complete'} ·{' '}
        <span className="merge-run-stat ok">{run.merged.length} merged</span>
        {run.conflicted.length > 0 && (
          <>
            {' '}·{' '}
            <span className="merge-run-stat conflict">
              {run.conflicted.length} conflict
              {run.conflicted.length === 1 ? '' : 's'}
            </span>
          </>
        )}
        {run.errored.length > 0 && (
          <>
            {' '}·{' '}
            <span
              className="merge-run-stat error"
              title={buildErrorsTooltip(run.errored, tasks)}
            >
              {run.errored.length} error
              {run.errored.length === 1 ? '' : 's'}
            </span>
          </>
        )}
      </span>
      <button
        className="merge-run-strip-btn"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}
