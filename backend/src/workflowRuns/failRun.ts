// failWorkflowRun — re-exported by the facade (../workflowRuns.ts). Lives here
// so dispatch.ts and advance.ts can error a run without importing the facade.

import { checkpointWorkflowRun, notify, runs, snapshot } from './state.js';
import { teardownWorkflowRun } from './teardown.js';

// Mark a live run errored (used by boot recovery when a run can't be resumed).
// Idempotent: a run that already finished stays as it is.
export function failWorkflowRun(runId: string, error: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'errored';
  run.finishedAt = Date.now();
  run.error = error;
  // Tear down all active members after the run leaves `running`.
  teardownWorkflowRun(run);
  notify({ type: 'errored', run: snapshot(run) });
  void checkpointWorkflowRun(run).catch(() => {});
  console.error(`[workflow-run] ${run.id} errored: ${error}`);
  return true;
}
