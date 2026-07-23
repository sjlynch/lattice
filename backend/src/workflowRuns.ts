// Workflow step runner — public facade.
//
// Sequential advancement is driven by:
//   - Agent steps:    Stop-hook / extension callbacks (POST
//                     /api/workflow-runs/:runId/steps/:n/complete) — never by
//                     watching task state.
//   - Control steps:  the step's own async worker calls completeWorkflowStep
//                     when its condition is met (Start finishes spawning
//                     tasks, Merge drains lanes, Push session reports done).
//
// 'parallel' is accepted in the schema but executed sequentially; the
// fan-out executor is intentionally deferred.
//
// Implementation lives in workflowRuns/:
//   - state.ts         registry + WS event fan-out
//   - stepMarkdown.ts  WORKFLOW_STEP.md rendering
//   - stepSpawner.ts   per-agent-step disk setup + pty pre-spawn
//   - controlStep.ts   start/merge/push executors
// This file owns just the orchestration: start, cancel, advance, kind-dispatch.

import {
  getWorkflow,
  normalizeWorkflowRunHarnessOverride,
  type Workflow,
  type WorkflowRunHarnessOverride,
} from './workflows.js';
import { normalizePiModel } from './worktree/commands.js';
import { generateWorkflowRunId } from './ids.js';
import {
  getActiveRunsForProject,
  notify,
  runs,
  snapshot,
  type WorkflowRun,
} from './workflowRuns/state.js';
import { spawnWorkflowStep } from './workflowRuns/stepSpawner.js';
import { executeControlStep } from './workflowRuns/controlStep.js';
import { cancelWorkflowStepSessions } from './workflowRuns/sessionSpawner.js';
import { cancelStopHookGate } from './workflowRuns/stopHookGate.js';

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
  // Pi model override, applied to every step when harnessOverride is `pi`.
  piModelOverride?: string;
  // Sequential-queue intent: refuse to start (throw WorkflowRunConflictError →
  // HTTP 409) if a run is already active for this project. Manual ▶ Run and
  // parallel-queue starts omit it — concurrency is intentional there. This is
  // the authoritative backend guard behind the frontend's best-effort
  // sequential gate, which reads only the frontend's `activeRuns` snapshot and
  // therefore has a startup-window / multi-tab race a lone client can't close.
  requireNoActiveRun?: boolean;
};

// Thrown by `startWorkflowRun` when `requireNoActiveRun` is set but a run is
// already active for the project. `routes/workflows/runs.ts` maps it to a 409
// (distinct from other 400s) so the frontend queue can requeue + retry rather
// than dropping the entry.
export class WorkflowRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunConflictError';
  }
}

// Refuse a new run while another is active for the same project. Throwing here
// — before any run record / `started` notify / spawn — keeps a rejected start
// side-effect-free.
export function assertNoActiveWorkflowRun(projectPath: string): void {
  const active = getActiveRunsForProject(projectPath);
  if (active.length > 0) {
    throw new WorkflowRunConflictError(
      `a workflow run is already active for this project (${active.length} running)`,
    );
  }
}

// Picks the right executor for a step. Agent steps run through the existing
// pty-pre-spawn path; control steps (start/merge/push) run through the
// headless control-step worker, which calls completeWorkflowStep itself when
// finished (we pass it in to avoid a circular import).
async function dispatchStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  const kind = wf.steps[stepIndex].kind ?? 'agent';
  if (kind === 'agent') {
    await spawnWorkflowStep(wf, run, stepIndex, backendOrigin);
    return;
  }
  // Agent steps emit `progress` from stepSpawner once their pty is ready;
  // control steps have no such moment, so the run-strip would otherwise
  // never see the new `currentStepIndex` until the control step finishes.
  // Emit progress here so the UI advances as soon as the control step
  // begins.
  notify({ type: 'progress', run: snapshot(run) });
  // Fire-and-forget. The control step's worker calls completeWorkflowStep
  // when its async work finishes (or marks the run errored on failure).
  executeControlStep(wf, run, stepIndex, backendOrigin, completeWorkflowStep);
}

export async function startWorkflowRun(
  workflowId: string,
  backendOrigin: string,
  options: StartWorkflowRunOptions = {},
): Promise<WorkflowRun> {
  const wf = await getWorkflow(workflowId);
  if (!wf) throw new Error('workflow not found');
  if (wf.steps.length === 0) throw new Error('workflow has no steps');

  // Authoritative sequential guard: when the caller demands an empty slot
  // (sequential-queue dispatch), reject if a run is already active. Runs before
  // any run record / notify / spawn so a rejected start is atomic.
  if (options.requireNoActiveRun) assertNoActiveWorkflowRun(wf.projectPath);

  const harnessOverride = normalizeWorkflowRunHarnessOverride(options.harnessOverride);
  // Only carry a model override when the run is overriding to Pi.
  const piModelOverride =
    harnessOverride === 'pi' ? normalizePiModel(options.piModelOverride) : undefined;
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
    ...(piModelOverride ? { piModelOverride } : {}),
  };
  runs.set(run.id, run);
  notify({ type: 'started', run: snapshot(run) });
  console.log(
    `[workflow-run] ${run.id} started (workflow=${wf.id} "${wf.name}", ${wf.steps.length} step(s), override=${harnessOverride ?? 'default'})`,
  );

  try {
    await dispatchStep(wf, run, 0, backendOrigin);
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
  cancelWorkflowStepSessions(run.id);
  cancelStopHookGate(run.id);
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
    await dispatchStep(wf, run, nextIndex, backendOrigin);
  } catch (err) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'advance failed';
    console.error(`[workflow-run] ${run.id} advance failed:`, err);
    notify({ type: 'errored', run: snapshot(run) });
  }
}
