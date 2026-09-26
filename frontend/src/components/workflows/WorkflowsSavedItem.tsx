import { memo } from 'react';
import { Play, Plus, Square } from 'lucide-react';
import type { Workflow, WorkflowRun, WorkflowRunHarnessOverride } from '../../api';
import { selectedOptionTitle, type HarnessOption } from '../../harnesses';
import {
  parseWorkflowRunOverride,
  serializeWorkflowRunOverride,
} from './workflowHarnessOverride';

type Props = {
  workflow: Workflow;
  isSelected: boolean;
  run?: WorkflowRun;
  // Its ▶ Run start is in flight — the button stays disabled until it settles.
  starting: boolean;
  queuedCount: number;
  harnessOverride: WorkflowRunHarnessOverride;
  piModelOverride?: string;
  harnessOptions: HarnessOption[];
  onSelect: (workflow: Workflow) => void;
  onSetHarnessOverride: (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride,
    piModel?: string,
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
  starting,
  queuedCount,
  harnessOverride,
  piModelOverride,
  harnessOptions,
  onSelect,
  onSetHarnessOverride,
  onEnqueue,
  onRun,
  onStopRun,
}: Props) {
  // Frozen steps stay in the definition but are skipped by the run engine, so
  // an all-frozen workflow has nothing to execute — block run/queue with a
  // reason rather than letting the backend 400 into an error toast.
  const frozenCount = workflow.steps.filter((s) => s.frozen === true).length;
  const runnableCount = workflow.steps.length - frozenCount;
  const blockedReason =
    workflow.steps.length === 0
      ? 'Add steps first'
      : runnableCount === 0
        ? 'Every step is frozen — unfreeze one first'
        : undefined;

  return (
    <div
      className={`workflows-item ${isSelected ? 'active' : ''}`}
      onClick={() => { if (!isSelected) onSelect(workflow); }}
    >
      <div className="workflows-item-name">{workflow.name}</div>
      <div className="workflows-item-meta">
        {workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'}
        {frozenCount > 0 && (
          <>
            {' · '}
            <span
              className="workflows-item-frozen"
              title="Frozen steps are skipped when this workflow runs"
            >
              {frozenCount} frozen
            </span>
          </>
        )}
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
      {/* The harness override + queue button stay visible while a run is in
          flight so the user can queue another copy of the same workflow (and
          pick a different harness for it) without first stopping the current
          run. The override is captured per-entry at enqueue/run time, so
          changing it here only affects the next workflow queued/run — never the
          in-progress run or already-queued entries. Only the run/stop button
          toggles on run state, mirroring the editor panel's Queue + Run/Stop. */}
      <div className="workflows-item-actions">
        <select
          className="workflows-item-harness workflows-step-harness"
          value={serializeWorkflowRunOverride(harnessOverride, piModelOverride)}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            event.stopPropagation();
            const sel = parseWorkflowRunOverride(event.target.value);
            onSetHarnessOverride(workflow.id, sel.harness, sel.piModel);
          }}
          title={`Run override: ${selectedOptionTitle(
            harnessOptions,
            serializeWorkflowRunOverride(harnessOverride, piModelOverride),
          )} (applies to the next queued/run copy; Default uses each step's harness/model)`}
          aria-label={`Run override for ${workflow.name}`}
        >
          {harnessOptions.map((option) => (
            <option key={option.value} value={option.value} title={option.title}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          className="workflows-item-run-btn"
          onClick={(event) => {
            event.stopPropagation();
            onEnqueue(workflow.id);
          }}
          disabled={Boolean(blockedReason)}
          title={blockedReason ?? 'Add to queue'}
          aria-label="Add workflow to queue"
        >
          <Plus size={12} />
        </button>
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
          <button
            className="workflows-item-run-btn"
            onClick={(event) => {
              event.stopPropagation();
              void onRun(workflow.id);
            }}
            disabled={Boolean(blockedReason) || starting}
            title={blockedReason ?? (starting ? 'Starting…' : 'Run workflow now')}
            aria-label="Run workflow now"
          >
            <Play size={11} fill="currentColor" />
          </button>
        )}
      </div>
    </div>
  );
});
