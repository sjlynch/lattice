import { memo } from 'react';
import { Play, Plus, Square } from 'lucide-react';
import type {
  Workflow,
  WorkflowRun,
  WorkflowRunHarnessOverride,
  WorkflowStepHarness,
} from '../../api';
import {
  parseWorkflowHarnessOverride,
  serializeWorkflowHarnessOverride,
  workflowHarnessOverrideLabel,
} from './workflowHarnessOverride';

type Props = {
  workflow: Workflow;
  isSelected: boolean;
  run?: WorkflowRun;
  queuedCount: number;
  harnessOverride: WorkflowRunHarnessOverride;
  harnessOptions: WorkflowStepHarness[];
  onSelect: (workflow: Workflow) => void;
  onSetHarnessOverride: (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride,
  ) => void;
  onEnqueue: (workflowId: string) => void;
  onRun: (workflowId: string) => void | Promise<unknown>;
  onStopRun: (runId: string) => void | Promise<unknown>;
};

// Memoized leaf: the saved list re-renders on every /ws/workflow-runs progress
// event, but with stable handler/option props each row only re-renders when its
// own workflow/run/queue state actually changes.
export const WorkflowsSavedItem = memo(function WorkflowsSavedItem({
  workflow,
  isSelected,
  run,
  queuedCount,
  harnessOverride,
  harnessOptions,
  onSelect,
  onSetHarnessOverride,
  onEnqueue,
  onRun,
  onStopRun,
}: Props) {
  return (
    <div
      className={`workflows-item ${isSelected ? 'active' : ''}`}
      onClick={() => onSelect(workflow)}
    >
      <div className="workflows-item-name">{workflow.name}</div>
      <div className="workflows-item-meta">
        {workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'}
        {queuedCount > 0 && (
          <>
            {' · '}
            <span className="workflows-item-queued">
              queued{queuedCount > 1 ? ` ×${queuedCount}` : ''}
            </span>
          </>
        )}
        {run && (
          <>
            {' · '}
            <span className="workflows-item-run">
              running {run.currentStepIndex + 1}/{run.totalSteps}
            </span>
          </>
        )}
      </div>
      <div className="workflows-item-actions">
        {run ? (
          <button
            className="workflows-item-run-btn danger"
            onClick={(event) => {
              event.stopPropagation();
              void onStopRun(run.id);
            }}
            title="Stop workflow run"
            aria-label="Stop workflow run"
          >
            <Square size={10} fill="currentColor" />
          </button>
        ) : (
          <>
            <select
              className="workflows-item-harness workflows-step-harness"
              value={serializeWorkflowHarnessOverride(harnessOverride)}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                event.stopPropagation();
                onSetHarnessOverride(
                  workflow.id,
                  parseWorkflowHarnessOverride(event.target.value),
                );
              }}
              title="Run override: Default uses each step's harness"
              aria-label={`Run override for ${workflow.name}`}
            >
              <option value="default">Default</option>
              {harnessOptions.map((harness) => (
                <option key={harness} value={harness}>
                  {workflowHarnessOverrideLabel(harness)}
                </option>
              ))}
            </select>
            <button
              className="workflows-item-run-btn"
              onClick={(event) => {
                event.stopPropagation();
                onEnqueue(workflow.id);
              }}
              disabled={workflow.steps.length === 0}
              title={
                workflow.steps.length === 0
                  ? 'Add steps before queueing'
                  : 'Add to queue'
              }
              aria-label="Add workflow to queue"
            >
              <Plus size={12} />
            </button>
            <button
              className="workflows-item-run-btn"
              onClick={(event) => {
                event.stopPropagation();
                void onRun(workflow.id);
              }}
              disabled={workflow.steps.length === 0}
              title={
                workflow.steps.length === 0
                  ? 'Add steps before running'
                  : 'Run workflow now'
              }
              aria-label="Run workflow now"
            >
              <Play size={11} fill="currentColor" />
            </button>
          </>
        )}
      </div>
    </div>
  );
});
