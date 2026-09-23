import { useCallback, useEffect, useRef } from 'react';
import type { Workflow, WorkflowRun } from '../../../api';
import type { EditorRunResult, StartOutcome } from './useWorkflowRunActions';

type Args = {
  // Runs the backend considers active for the project (the `/ws/workflow-runs`
  // view). Read through a ref at click time, so the callbacks stay stable.
  activeRuns: Record<string, WorkflowRun>;
  runWorkflow: (workflowId: string) => Promise<StartOutcome>;
  runEditorWorkflow: () => Promise<EditorRunResult>;
  enqueueWorkflow: (workflowId: string) => boolean;
  enqueueWorkflowDefinition: (wf: Workflow) => boolean;
  enqueueEditorWorkflow: () => Promise<boolean>;
  startQueuedWorkflows: () => void;
  // The workflow panel's toast slot.
  notify: (msg: string) => void;
};

// Name of the run a new start would wait behind: the oldest active run (a
// project runs one workflow at a time, so normally the only one). Null when
// this tab doesn't know of one yet — the backend's 409 can beat the WS event.
function activeWorkflowName(activeRuns: Record<string, WorkflowRun>): string | null {
  const oldest = Object.values(activeRuns).sort((a, b) => a.startedAt - b.startedAt)[0];
  return oldest ? oldest.workflowName : null;
}

// The manual ▶ Run buttons (editor footer + saved-list row). A project runs one
// workflow at a time — the backend 409s a second start — so when a run is
// already active (known locally, or learned from the 409) the workflow goes on
// the sequential queue instead, with a "Queued behind <name>" toast. The queue
// is started too: the click is an explicit "run this", so the entry must not
// sit idle behind a queue the user stopped earlier (an enqueue only auto-starts
// the queue when the active run isn't queue-owned).
export function useWorkflowManualRun({
  activeRuns,
  runWorkflow,
  runEditorWorkflow,
  enqueueWorkflow,
  enqueueWorkflowDefinition,
  enqueueEditorWorkflow,
  startQueuedWorkflows,
  notify,
}: Args) {
  const activeRunsRef = useRef(activeRuns);
  useEffect(() => {
    activeRunsRef.current = activeRuns;
  }, [activeRuns]);

  const queuedBehindActive = useCallback((queued: boolean, knownActive: string | null) => {
    if (!queued) return;
    startQueuedWorkflows();
    const name = knownActive ?? activeWorkflowName(activeRunsRef.current);
    notify(name ? `Queued behind "${name}"` : 'Queued behind the active workflow');
  }, [notify, startQueuedWorkflows]);

  const runWorkflowOrQueue = useCallback(async (workflowId: string) => {
    const active = activeWorkflowName(activeRunsRef.current);
    if (active !== null) {
      queuedBehindActive(enqueueWorkflow(workflowId), active);
      return;
    }
    const outcome = await runWorkflow(workflowId);
    if (outcome.status === 'busy') queuedBehindActive(enqueueWorkflow(workflowId), null);
  }, [enqueueWorkflow, queuedBehindActive, runWorkflow]);

  const runEditorWorkflowOrQueue = useCallback(async () => {
    const active = activeWorkflowName(activeRunsRef.current);
    if (active !== null) {
      queuedBehindActive(await enqueueEditorWorkflow(), active);
      return;
    }
    const result = await runEditorWorkflow();
    if (result?.outcome.status === 'busy') {
      // By workflow object, not id: a never-saved draft was created by this
      // very click and may not be in the saved-workflow map yet.
      queuedBehindActive(enqueueWorkflowDefinition(result.workflow), null);
    }
  }, [enqueueEditorWorkflow, enqueueWorkflowDefinition, queuedBehindActive, runEditorWorkflow]);

  return { runWorkflowOrQueue, runEditorWorkflowOrQueue };
}
