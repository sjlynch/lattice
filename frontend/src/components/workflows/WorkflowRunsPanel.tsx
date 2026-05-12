import { Square } from 'lucide-react';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { QueuePanel } from './QueuePanel';

type Props = {
  manager: WorkflowManager;
};

export function WorkflowRunsPanel({ manager }: Props) {
  const { activeRunList, actions } = manager;

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
    </aside>
  );
}
