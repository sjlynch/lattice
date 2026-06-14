import { X } from 'lucide-react';
import type { MergeRun, Task } from '../../api';
import {
  buildErrorsTooltip,
  formatConflictStat,
  formatErrorStat,
  formatMergeStat,
} from './mergeRunStatFormatting';

// Presentational strip states for MergeRunStrip. Each renders one phase of
// a backend merge run; the dispatcher in MergeRunStrip.tsx picks which to
// show. Stat wording is centralized in mergeRunStatFormatting.ts.

export function ActiveStrip({
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
              <span className="merge-run-stat ok">
                {formatMergeStat(run.merged.length)}
              </span>
            )}
            {run.conflicted.length > 0 && (
              <span className="merge-run-stat conflict">
                {formatConflictStat(run.conflicted.length)}
              </span>
            )}
            {run.errored.length > 0 && (
              <span
                className="merge-run-stat error"
                title={buildErrorsTooltip(run.errored, tasks)}
              >
                {formatErrorStat(run.errored.length)}
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

export function ResolvingStrip({ conflicts }: { conflicts: Task[] }) {
  const first = conflicts[0];
  const extra = conflicts.length - 1;
  return (
    <div className="merge-run-strip running" role="status">
      <span className="merge-run-strip-spinner" />
      <span className="merge-run-strip-text">
        Resolving{' '}
        <span className="merge-run-stat conflict">
          {formatConflictStat(conflicts.length)}
        </span>
        <div className="merge-run-strip-current">
          {first.title}
          {extra > 0 && ` + ${extra} more`}
        </div>
      </span>
    </div>
  );
}

export function SummaryStrip({
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
        <span className="merge-run-stat ok">
          {formatMergeStat(run.merged.length)}
        </span>
        {run.conflicted.length > 0 && (
          <>
            {' '}·{' '}
            <span className="merge-run-stat conflict">
              {formatConflictStat(run.conflicted.length)}
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
              {formatErrorStat(run.errored.length)}
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
