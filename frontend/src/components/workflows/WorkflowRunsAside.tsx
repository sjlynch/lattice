import { Square, X } from 'lucide-react';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { QueuePanel } from './QueuePanel';
import { workflowHarnessOverrideLabel } from './workflowHarnessOverride';

type Props = {
  manager: WorkflowManager;
};

export function WorkflowRunsAside({ manager }: Props) {
  const { activeRunList, recentFailedRunList, actions } = manager;

  return (
    <aside className="workflows-runs">
      <div className="workflows-list-head">
        <span className="workflows-list-title">Queue & active</span>
      </div>
      <QueuePanel manager={manager} />

      <div className="workflows-runs-section">
        <div className="workflows-runs-section-title">Active</div>
        {activeRunList.length === 0 ? (
          <div className="workflows-runs-empty">No active workflow runs.</div>
        ) : (
          <div className="workflows-runs-list">
            {activeRunList.map((run) => {
              const pos = Math.min(run.currentStepIndex + 1, run.totalSteps);
              const pct = run.totalSteps > 0 ? Math.round((pos / run.totalSteps) * 100) : 0;
              return (
                <div key={run.id} className="workflows-run-card active">
                  <div className="workflows-run-card-main">
                    <span className="workflows-run-card-name">{run.workflowName}</span>
                    <span className="workflows-run-card-meta">
                      Step {pos}/{run.totalSteps} · {pct}%
                      {run.harnessOverride
                        ? ` · Override: ${workflowHarnessOverrideLabel(run.harnessOverride)}`
                        : ''}
                    </span>
                    <div className="workflows-run-progress" aria-hidden>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <button
                    className="icon-btn sm danger"
                    onClick={() => void actions.stopRun(run.id)}
                    aria-label="Stop workflow run"
                    title="Stop workflow run"
                  >
                    <Square size={10} fill="currentColor" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {recentFailedRunList.length > 0 && (
        // Recently-failed runs (errored or cancelled) linger ~5min in the
        // recent-runs map so a user who looked away from the screen still
        // sees them when they return. Per-run dismiss removes them sooner.
        <div className="workflows-runs-section">
          <div className="workflows-runs-section-title">Recently failed</div>
          <div className="workflows-runs-list">
            {recentFailedRunList.map((run) => {
              const label = run.status === 'errored' ? 'Errored' : 'Cancelled';
              return (
                <div key={run.id} className="workflows-run-card failed">
                  <div className="workflows-run-card-main">
                    <span className="workflows-run-card-name">{run.workflowName}</span>
                    <span className="workflows-run-card-meta">
                      {label}
                      {run.error ? ` — ${run.error}` : ''}
                    </span>
                  </div>
                  <button
                    className="icon-btn sm"
                    onClick={() => actions.dismissRecent(run.id)}
                    aria-label="Dismiss"
                    title="Dismiss"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
