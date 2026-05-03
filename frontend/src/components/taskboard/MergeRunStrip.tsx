import { X } from 'lucide-react';
import type { MergeRun, Task } from '../../api';

// Progress strip rendered above the Ready-to-Merge lane during a backend
// merge run. Switches to a dismissable summary on completion or cancel.
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
  if (active) return <ActiveStrip run={active} tasks={tasks} onCancel={onCancel} />;
  if (summary) return <SummaryStrip run={summary} onDismiss={onDismiss} />;
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
              <span className="merge-run-stat error">
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

function SummaryStrip({
  run,
  onDismiss,
}: {
  run: MergeRun;
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
            <span className="merge-run-stat error">
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
