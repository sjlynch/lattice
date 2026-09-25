// Shared "error a running run" transition for the workflow-run workers that
// fail a run without an active step to tear down (control-step workers, a
// step whose spawn failed). `failWorkflowRun` in ../workflowRuns.ts is NOT
// this: it tears the active step down between setting the error and notifying.

import { checkpointWorkflowRun, notify, snapshot, type WorkflowRun } from './state.js';

export function markRunErrored(run: WorkflowRun, error: string): void {
  run.status = 'errored';
  run.finishedAt = Date.now();
  run.error = error;
  notify({ type: 'errored', run: snapshot(run) });
  // Make the terminal state durable NOW: `notify` only schedules the
  // debounced mirror, and a restart inside that window left the run
  // `running` on disk, so boot resume re-dispatched a finished step (see
  // cancelWorkflowRun in ../workflowRuns.ts).
  void checkpointWorkflowRun(run).catch(() => {});
}
