import { AlertTriangle } from 'lucide-react';
import type { WorkflowRun } from '../../api';

type Props = {
  failedRuns: WorkflowRun[];
  onOpen: () => void;
};

// Small navbar chip rendered when one or more recently-finished workflow runs
// ended in failure (errored or cancelled). Persists for ~5min via the recent-
// runs linger window in `useWorkflowRuns`, so a user who looked away from the
// screen still sees the failure signal when they return — addressing the
// "workflow vanished with no UI feedback" gap behind the disappearing-chip
// incident.
//
// Clicking opens the Workflows panel; per-run dismissal happens there via the
// "Recently failed" section in `WorkflowRunsAside`.
export function WorkflowRecentFailureChip({ failedRuns, onOpen }: Props) {
  if (failedRuns.length === 0) return null;

  const erroredCount = failedRuns.filter((r) => r.status === 'errored').length;
  const cancelledCount = failedRuns.length - erroredCount;

  // Single-run mode shows the workflow name + reason; multi-run mode shows the
  // counts so the chip width is bounded.
  const text = (() => {
    if (failedRuns.length === 1) {
      const r = failedRuns[0];
      const label = r.status === 'errored' ? 'errored' : 'cancelled';
      return `${r.workflowName} ${label}`;
    }
    if (erroredCount > 0 && cancelledCount > 0) {
      return `${erroredCount} errored · ${cancelledCount} cancelled`;
    }
    if (erroredCount > 0) return `${erroredCount} workflow${erroredCount === 1 ? '' : 's'} errored`;
    return `${cancelledCount} workflow${cancelledCount === 1 ? '' : 's'} cancelled`;
  })();

  const titleAttr = failedRuns
    .map((r) => `${r.workflowName}: ${r.status}${r.error ? ` — ${r.error}` : ''}`)
    .join('\n');

  return (
    <button
      className="wf-run-chip failure"
      onClick={onOpen}
      title={titleAttr}
      aria-label={`Recent workflow failures: ${text}`}
    >
      <AlertTriangle size={11} className="wf-run-chip-failure-icon" aria-hidden />
      <span className="wf-run-chip-text">{text}</span>
    </button>
  );
}
