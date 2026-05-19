import { Square, X } from 'lucide-react';
import type { WorkflowRun } from '../../api';
import type { ControlProgress } from './hooks/useWorkflowRuns';

// Per-kind label used in the run strip when a control step is executing.
const CONTROL_KIND_LABEL: Record<ControlProgress['kind'], string> = {
  agent: 'Agent step',
  start: 'Start',
  merge: 'Merge',
  push: 'Push',
};

// Progress strip rendered above the editor while a run is in flight.
// Switches to a dismissable summary on completion or error.
//
// When a control step (start/merge/push) is mid-execution, `controlProgress`
// describes its kind-specific state and the strip surfaces that instead of
// the generic "step N of M" line.
export function WorkflowRunStrip({
  active,
  controlProgress,
  summary,
  onDismiss,
  onStop,
}: {
  active: WorkflowRun | null;
  controlProgress?: ControlProgress | null;
  summary: WorkflowRun | null;
  onDismiss: () => void;
  onStop?: () => void;
}) {
  if (active) {
    const pos = Math.min(active.currentStepIndex + 1, active.totalSteps);
    const pct =
      active.totalSteps > 0 ? Math.round((pos / active.totalSteps) * 100) : 0;

    // Surface control-step progress only when it belongs to the currently-
    // executing step (defensive — stale events get filtered in useWorkflowRuns
    // on 'progress' advance, but the run object is the source of truth).
    const controlForThisStep =
      controlProgress && controlProgress.stepIndex === active.currentStepIndex
        ? controlProgress
        : null;

    return (
      <div className="merge-run-strip running" role="status">
        <span className="merge-run-strip-spinner" />
        <span className="merge-run-strip-text">
          {controlForThisStep
            ? renderControlText(controlForThisStep, pos, active.totalSteps)
            : `Step ${pos} of ${active.totalSteps}`}
        </span>
        <span className="merge-run-strip-pct">{pct}%</span>
        {onStop && (
          <button
            className="merge-run-strip-btn"
            onClick={onStop}
            aria-label="Stop workflow run"
            title="Stop workflow run"
          >
            <Square size={10} fill="currentColor" />
          </button>
        )}
      </div>
    );
  }
  if (summary) {
    const cancelled = summary.status === 'cancelled';
    const errored = summary.status === 'errored';
    return (
      <div
        className={`merge-run-strip done ${errored || cancelled ? 'cancelled' : ''}`}
        role="status"
      >
        <span className="merge-run-strip-text">
          {cancelled
            ? 'Run stopped'
            : errored
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

function renderControlText(
  cp: ControlProgress,
  stepPos: number,
  totalSteps: number,
): string {
  const label = CONTROL_KIND_LABEL[cp.kind] ?? cp.kind;
  const stepCount = `Step ${stepPos} of ${totalSteps}`;
  if (cp.message) {
    return `${stepCount} · ${label}: ${cp.message}`;
  }
  if (cp.total > 0) {
    return `${stepCount} · ${label} ${cp.current}/${cp.total}`;
  }
  return `${stepCount} · ${label}`;
}
