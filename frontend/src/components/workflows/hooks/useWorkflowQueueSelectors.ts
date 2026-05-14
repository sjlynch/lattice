import { useMemo } from 'react';
import type {
  Workflow,
  WorkflowQueueEntry,
  WorkflowRun,
} from '../../../api';
import type { QueueState } from '../queueScheduler';

type Args = {
  queueState: QueueState;
  workflowsById: Map<string, Workflow>;
  activeRuns: Record<string, WorkflowRun>;
};

export type WorkflowQueueSelectors = {
  queuedItems: Array<{ entry: WorkflowQueueEntry; workflow: Workflow }>;
  busy: boolean;
  disabled: boolean;
  status: string;
};

// Derived view of the queue scheduler state: queued entries joined with
// their workflow records, plus the busy/disabled flags and status string the
// queue panel renders. `busy` reflects an in-flight HTTP /run (not "queue is
// processing a long-running workflow"), so Clear / Remove-from-queue stay
// interactive once the backend acknowledges the start.
export function useWorkflowQueueSelectors({
  queueState,
  workflowsById,
  activeRuns,
}: Args): WorkflowQueueSelectors {
  const queuedItems = useMemo(
    () =>
      queueState.queued
        .map((entry) => ({ entry, workflow: workflowsById.get(entry.workflowId) }))
        .filter(
          (item): item is { entry: WorkflowQueueEntry; workflow: Workflow } =>
            Boolean(item.workflow),
        ),
    [queueState.queued, workflowsById],
  );

  const busy = queueState.started.some((entry) => entry.runId === null);
  const queueActive = queueState.started.find((entry) => {
    const runId = entry.runId;
    return runId !== null && activeRuns[runId];
  });
  const disabled = queueState.queued.length === 0 || busy;
  const status = queueState.running
    ? queueActive
      ? 'Running current workflow; next queued item starts when it finishes.'
      : busy
        ? 'Starting next queued workflow…'
        : 'Waiting to start next queued workflow…'
    : queueState.queued.length > 0
      ? `${queueState.queued.length} workflow${queueState.queued.length === 1 ? '' : 's'} queued.`
      : 'Queue saved workflows, then choose sequential or parallel start.';

  return { queuedItems, busy, disabled, status };
}
