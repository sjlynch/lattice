import { Play, X } from 'lucide-react';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { workflowHarnessOverrideLabel } from './workflowHarnessOverride';

type Props = {
  manager: WorkflowManager;
};

export function QueuePanel({ manager }: Props) {
  const { queue, actions } = manager;

  return (
    <>
      <div className="workflows-queue-mode" role="group" aria-label="Workflow queue mode">
        <button
          className={queue.mode === 'sequential' ? 'active' : ''}
          onClick={() => actions.setQueueMode('sequential')}
          disabled={queue.running}
          title="Run one queued workflow after the previous one finishes"
        >
          Sequential
        </button>
        <button
          className={queue.mode === 'parallel' ? 'active' : ''}
          onClick={() => actions.setQueueMode('parallel')}
          disabled={queue.running}
          title="Start all queued workflows at once"
        >
          Parallel
        </button>
      </div>
      <div className="workflows-queue-controls">
        <button
          className="btn-primary"
          onClick={() => void actions.startQueuedWorkflows()}
          disabled={queue.disabled || queue.running}
        >
          <Play size={11} fill="currentColor" /> Start queue
        </button>
        {queue.running ? (
          <button className="btn-ghost" onClick={actions.stopQueue}>
            Stop queue
          </button>
        ) : (
          <button
            className="btn-ghost"
            onClick={actions.clearQueue}
            disabled={queue.queuedEntries.length === 0}
          >
            Clear
          </button>
        )}
      </div>
      <div className="workflows-queue-status">{queue.status}</div>

      <div className="workflows-runs-section">
        <div className="workflows-runs-section-title">Queued</div>
        {queue.queuedItems.length === 0 ? (
          <div className="workflows-runs-empty">No queued workflows.</div>
        ) : (
          <div className="workflows-runs-list">
            {queue.queuedItems.map(({ entry, workflow }, index) => (
              <div key={entry.id} className="workflows-run-card queued">
                <div className="workflows-run-card-main">
                  <span className="workflows-run-card-name">{index + 1}. {workflow.name}</span>
                  <span className="workflows-run-card-meta">
                    {workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'}
                    {' · '}
                    Override: {workflowHarnessOverrideLabel(entry.harnessOverride)}
                  </span>
                </div>
                <button
                  className="icon-btn sm"
                  onClick={() => actions.removeQueuedWorkflow(entry.id)}
                  aria-label="Remove from queue"
                  title="Remove from queue"
                  disabled={queue.running && queue.busy}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
