import { X } from 'lucide-react';
import type { WorkflowRun } from '../../api';

// Progress strip rendered above the editor while a run is in flight.
// Switches to a dismissable summary on completion or error.
export function WorkflowRunStrip({
  active,
  summary,
  onDismiss,
}: {
  active: WorkflowRun | null;
  summary: WorkflowRun | null;
  onDismiss: () => void;
}) {
  if (active) {
    const pos = Math.min(active.currentStepIndex + 1, active.totalSteps);
    const pct =
      active.totalSteps > 0 ? Math.round((pos / active.totalSteps) * 100) : 0;
    return (
      <div className="merge-run-strip running" role="status">
        <span className="merge-run-strip-spinner" />
        <span className="merge-run-strip-text">
          Step {pos} of {active.totalSteps}
        </span>
        <span className="merge-run-strip-pct">{pct}%</span>
      </div>
    );
  }
  if (summary) {
    const errored = summary.status === 'errored';
    return (
      <div
        className={`merge-run-strip done ${errored ? 'cancelled' : ''}`}
        role="status"
      >
        <span className="merge-run-strip-text">
          {errored
            ? `Run errored: ${summary.error ?? 'unknown error'}`
            : 'Workflow complete'}
        </span>
        <button
          className="merge-run-strip-btn"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    );
  }
  return null;
}
