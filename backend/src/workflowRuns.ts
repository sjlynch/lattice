// Workflow step runner — public facade.
//
// Sequential advancement is driven entirely by Stop-hook / extension
// callbacks (POST /api/workflow-runs/:runId/steps/:n/complete) — not by
// watching task state. 'parallel' steps are accepted in the schema but
// executed sequentially; the fan-out executor is intentionally deferred.
//
// Implementation lives in workflowRuns/:
//   - state.ts         registry + WS event fan-out
//   - stepMarkdown.ts  WORKFLOW_STEP.md rendering
//   - stepSpawner.ts   per-step disk setup + pty pre-spawn
// This file owns just the orchestration: start, cancel, advance.

import {
  getWorkflow,
  normalizeWorkflowRunHarnessOverride,
  type WorkflowRunHarnessOverride,
} from './workflows.js';
import { generateWorkflowRunId } from './ids.js';
import {
  notify,
  runs,
  snapshot,
  type WorkflowRun,
} from './workflowRuns/state.js';
import { spawnWorkflowStep } from './workflowRuns/stepSpawner.js';

export type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunEvent,
} from './workflowRuns/state.js';
export {
  getRun,
  getActiveRunsForProject,
  subscribe,
} from './workflowRuns/state.js';

export type StartWorkflowRunOptions = {
  harnessOverride?: WorkflowRunHarnessOverride;
};

export async function startWorkflowRun(
  workflowId: string,
  backendOrigin: string,
  options: StartWorkflowRunOptions = {},
): Promise<WorkflowRun> {
  const wf = await getWorkflow(workflowId);
  if (!wf) throw new Error('workflow not found');
  if (wf.steps.length === 0) throw new Error('workflow has no steps');

  const harnessOverride = normalizeWorkflowRunHarnessOverride(options.harnessOverride);
  const run: WorkflowRun = {
    id: generateWorkflowRunId(),
    workflowId: wf.id,
    workflowName: wf.name,
    projectPath: wf.projectPath,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: wf.steps.length,
    currentStepIndex: 0,
    ...(harnessOverride ? { harnessOverride } : {}),
  };
  runs.set(run.id, run);
  notify({ type: 'started', run: snapshot(run) });
  console.log(
    `[workflow-run] ${run.id} started (workflow=${wf.id} "${wf.name}", ${wf.steps.length} step(s), override=${harnessOverride ?? 'default'})`,
  );

  try {
    await spawnWorkflowStep(wf, run, 0, backendOrigin);
    return snapshot(run);
  } catch (err) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'spawn failed';
    notify({ type: 'errored', run: snapshot(run) });
    console.error(`[workflow-run] ${run.id} failed to start step 0:`, err);
    throw err;
  }
}

export function cancelWorkflowRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  notify({ type: 'cancelled', run: snapshot(run) });
  console.log(`[workflow-run] ${run.id} cancelled`);
  return true;
}

// Called by the Stop-hook callback. Idempotent: stale hooks (same stepIndex
// re-firing) are silently ignored via the currentStepIndex check.
export async function completeWorkflowStep(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;
  if (stepIndex !== run.currentStepIndex) return;

  const nextIndex = stepIndex + 1;
  // Claim ownership synchronously before any await so a duplicate Stop-hook
  // fire is ignored by the check above.
  run.currentStepIndex = nextIndex;

  try {
    const wf = await getWorkflow(run.workflowId);
    if (!wf) {
      run.status = 'errored';
      run.finishedAt = Date.now();
      run.error = 'workflow definition not found';
      notify({ type: 'errored', run: snapshot(run) });
      return;
    }
    if (nextIndex >= wf.steps.length) {
      run.status = 'completed';
      run.finishedAt = Date.now();
      console.log(`[workflow-run] ${run.id} completed all ${wf.steps.length} step(s)`);
      notify({ type: 'completed', run: snapshot(run) });
      return;
    }
    console.log(`[workflow-run] ${run.id} advancing step ${stepIndex} → ${nextIndex}`);
    await spawnWorkflowStep(wf, run, nextIndex, backendOrigin);
  } catch (err) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'advance failed';
    console.error(`[workflow-run] ${run.id} advance failed:`, err);
    notify({ type: 'errored', run: snapshot(run) });
  }
}
