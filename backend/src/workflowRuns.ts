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
  checkpointWorkflowRun,
} from './workflowRuns/state.js';
import { spawnWorkflowStep } from './workflowRuns/stepSpawner.js';
import { nextRunnableStepIndex } from './workflowRuns/frozenSteps.js';
import { executeControlStep } from './workflowRuns/controlStep.js';
import { cancelWorkflowStepSessions, killWorkflowStepSession } from './workflowRuns/sessionSpawner.js';
import { cancelStopHookGate } from './workflowRuns/stopHookGate.js';
import { cloneWorkflowDefinition } from './workflowRuns/definition.js';

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
  if (run.definitionError) throw new Error(run.definitionError);
  if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
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
  run.stepPhase = 'running';
  await checkpointWorkflowRun(run);
  if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
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

  // Frozen steps are skipped, so a run starts at the first thawed step rather
  // than always at 0. All-frozen is refused outright — starting a run that
  // instantly completes reads as a silent no-op to the user.
  const firstIndex = nextRunnableStepIndex(wf.steps, 0);
  if (firstIndex === null) {
    throw new Error('every step in this workflow is frozen');
  }

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
    currentStepIndex: firstIndex,
    definition: cloneWorkflowDefinition(wf),
    stepPhase: 'pending',
    ...(harnessOverride ? { harnessOverride } : {}),
    ...(piModelOverride ? { piModelOverride } : {}),
  };
  runs.set(run.id, run);
  notify({ type: 'started', run: snapshot(run) });
  console.log(
    `[workflow-run] ${run.id} started (workflow=${wf.id} "${wf.name}", ${wf.steps.length} step(s), override=${harnessOverride ?? 'default'})`,
  );

  try {
    await checkpointWorkflowRun(run);
    await dispatchStep(run.definition!, run, firstIndex, backendOrigin);
    return snapshot(run);
  } catch (err) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'spawn failed';
    notify({ type: 'errored', run: snapshot(run) });
    console.error(`[workflow-run] ${run.id} failed to start step ${firstIndex}:`, err);
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

// ---------------------------------------------------------------------------
// Restart recovery surface (see workflowRuns/persistence.ts + the boot resume
// in recovery/workflowRunResume.ts). A run lives in this process's memory, so
// a restart during a long agent step used to drop it silently: the navbar chip
// vanished and the step's still-running agent POSTed /complete into a backend
// that no longer knew the run, so every remaining step never ran.
// ---------------------------------------------------------------------------

// Re-insert a run persisted by a previous backend process. Returns false if the
// id is already live (nothing to restore). Emits `progress` so any connected
// client re-renders it immediately rather than waiting for the next WS `hello`.
export function restoreWorkflowRun(persisted: WorkflowRun): boolean {
  if (runs.has(persisted.id)) return false;
  const run: WorkflowRun = { ...snapshot(persisted), status: 'running' };
  runs.set(run.id, run);
  notify({ type: 'progress', run: snapshot(run) });
  return true;
}

// Re-run the run's CURRENT step. Only for control steps (start/merge/push),
// which execute in-process and are therefore killed outright by a restart —
// unlike an agent step, whose pty survives in the detached terminal-server.
export async function redispatchCurrentWorkflowStep(
  runId: string,
  backendOrigin: string,
): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;
  try {
    if (run.definitionError) throw new Error(run.definitionError);
    const wf = run.definition ?? await getWorkflow(run.workflowId);
    if (!wf) throw new Error('workflow definition not found');
    if (run.currentStepIndex >= wf.steps.length) {
      throw new Error(
        `current step ${run.currentStepIndex} is outside the workflow's ${wf.steps.length} step(s)`,
      );
    }
    await dispatchStep(wf, run, run.currentStepIndex, backendOrigin);
  } catch (err) {
    failWorkflowRun(runId, (err as Error).message ?? 'resume failed');
  }
}

// Mark a live run errored (used by boot recovery when a run can't be resumed).
// Idempotent: a run that already finished stays as it is.
export function failWorkflowRun(runId: string, error: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'errored';
  run.finishedAt = Date.now();
  run.error = error;
  cancelWorkflowStepSessions(run.id);
  cancelStopHookGate(run.id);
  notify({ type: 'errored', run: snapshot(run) });
  console.error(`[workflow-run] ${run.id} errored: ${error}`);
  return true;
}

// Called by the Stop-hook callback. Idempotent: stale hooks (same stepIndex
// re-firing) are silently ignored via the currentStepIndex check.
export async function completeWorkflowStep(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
  deps: { killStepSession?: typeof killWorkflowStepSession; dispatchStep?: typeof dispatchStep } = {},
): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;
  if (run.definitionError) throw new Error(run.definitionError);
  if (stepIndex !== run.currentStepIndex) return;

  const key = `${runId}:${stepIndex}`;
  if (completions.has(key)) return completions.get(key);
  const completing = advanceCompletedStep(run, stepIndex, backendOrigin, deps);
  completions.set(key, completing);
  try { await completing; } finally { if (completions.get(key) === completing) completions.delete(key); }
}

const completions = new Map<string, Promise<void>>();

async function advanceCompletedStep(run: WorkflowRun, stepIndex: number, backendOrigin: string,
  deps: { killStepSession?: typeof killWorkflowStepSession; dispatchStep?: typeof dispatchStep }): Promise<void> {
  const claimedIndex = stepIndex + 1;
  // Keep the index on the finishing step until its completion and terminal
  // teardown are durable. The per-step promise deduplicates concurrent hooks
  // while allowing the next step to finish during its predecessor's dispatch.
  const previousPhase = run.stepPhase;
  run.stepPhase = 'completing';
  // A failed completion write is retriable: do not kill the agent or return a
  // successful HTTP acknowledgement for work that only exists in memory.
  try {
    await checkpointWorkflowRun(run);
  } catch (err) {
    if (run.status === 'running' && run.currentStepIndex === stepIndex) run.stepPhase = previousPhase;
    throw err;
  }
  try {
    await (deps.killStepSession ?? killWorkflowStepSession)(run.id, stepIndex);
    if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
    const wf = run.definition ?? await getWorkflow(run.workflowId);
    if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
    if (!wf) {
      run.status = 'errored';
      run.finishedAt = Date.now();
      run.error = 'workflow definition not found';
      notify({ type: 'errored', run: snapshot(run) });
      return;
    }
    // Walk past any frozen steps between here and the next runnable one; `null`
    // means nothing runnable is left (end of workflow, or only frozen steps).
    const nextIndex = nextRunnableStepIndex(wf.steps, claimedIndex);
    if (nextIndex === null) {
      // Park the index past the last step so every editor row reads as done.
      // `max` keeps a claim that already overshot (workflow shortened mid-run).
      run.currentStepIndex = Math.max(run.currentStepIndex, wf.steps.length);
      run.status = 'completed';
      run.finishedAt = Date.now();
      console.log(`[workflow-run] ${run.id} completed all ${wf.steps.length} step(s)`);
      notify({ type: 'completed', run: snapshot(run) });
      await checkpointWorkflowRun(run);
      return;
    }
    run.currentStepIndex = nextIndex;
    run.stepPhase = 'pending';
    delete run.stepSessionId;
    await checkpointWorkflowRun(run);
    if (nextIndex !== claimedIndex) {
      console.log(
        `[workflow-run] ${run.id} skipping frozen step(s) ${claimedIndex}..${nextIndex - 1}`,
      );
    }
    console.log(`[workflow-run] ${run.id} advancing step ${stepIndex} → ${nextIndex}`);
    await (deps.dispatchStep ?? dispatchStep)(wf, run, nextIndex, backendOrigin);
  } catch (err) {
    if (run.status !== 'running') return;
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'advance failed';
    console.error(`[workflow-run] ${run.id} advance failed:`, err);
    notify({ type: 'errored', run: snapshot(run) });
  }
}
