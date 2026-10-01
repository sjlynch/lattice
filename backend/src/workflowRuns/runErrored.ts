// Shared "error a running run" transition for control and spawn workers.
// Like failWorkflowRun in the facade, it reclaims every active member before
// notifying, without importing the facade back into its workers.

import { checkpointWorkflowRun, notify, snapshot, type WorkflowRun } from './state.js';
import { teardownWorkflowRun } from './teardown.js';

export function markRunErrored(run: WorkflowRun, error: string): void {
  if (run.status !== 'running') return;
  run.status = 'errored';
  run.finishedAt = Date.now();
  run.error = error;
  teardownWorkflowRun(run);
  notify({ type: 'errored', run: snapshot(run) });
  // Make the terminal state durable NOW: `notify` only schedules the
  // debounced mirror, and a restart inside that window left the run
  // `running` on disk, so boot resume re-dispatched a finished step (see
  // cancelWorkflowRun in ../workflowRuns.ts).
  void checkpointWorkflowRun(run).catch(() => {});
}
