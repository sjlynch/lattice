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
// Steps always run one after another, and a project runs one workflow at a
// time (`assertNoActiveWorkflowRun`).
//
// Implementation lives in workflowRuns/:
//   - state.ts         registry + WS event fan-out
//   - stepMarkdown.ts  WORKFLOW_STEP.md rendering
//   - stepSpawner.ts   per-agent-step disk setup + pty pre-spawn
//   - controlStep.ts   start/merge/push executors
//   - testStep/        the Run tests step (an agent step that never stops the run)
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
import {
  cancelWorkflowStepSessions,
  killWorkflowStepSession,
  releaseWorkflowStepSession,
  workflowStepAgentId,
} from './workflowRuns/sessionSpawner.js';
import { isKeepWorkflowStepTerminalsEnabled } from './userSettings.js';
import { cancelStopHookGate } from './workflowRuns/stopHookGate.js';
import { forgetAgentQuiescence } from './agentQuiescence.js';
import { abortStepPreRun } from './workflowRuns/stepTools.js';
import { cloneWorkflowDefinition } from './workflowRuns/definition.js';
import {
  abortRunTestsStep,
  dispatchRunTestsStep,
  finalizeRunTestsStep,
} from './workflowRuns/testStep/runTestsStep.js';

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
};

// Thrown by `startWorkflowRun` when a run is already active for the project —
// one workflow run per project, always. `routes/workflows/runs.ts` maps it to
// a 409 (distinct from other 400s) so the frontend queue can requeue + retry
// (and a manual ▶ Run can enqueue) rather than dropping the start. This is the
// authoritative guard behind the frontend's best-effort sequential gate, which
// reads only the frontend's `activeRuns` snapshot and therefore has a
// startup-window / multi-tab race a lone client can't close.
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
  if (kind === 'test') {
    // Run tests is an agent step (it spawns through spawnWorkflowStep and
    // completes through the /complete route), but its skip check, lock wait
    // and USER_WIP capture run DETACHED — like a control step — so a skip
    // doesn't advance recursively inside the previous step's completion.
    // The phase stays `pending` until its pty is requested, which is what a
    // restart re-dispatches.
    notify({ type: 'progress', run: snapshot(run) });
    dispatchRunTestsStep(wf, run, stepIndex, backendOrigin, completeWorkflowStep);
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

  // Authoritative one-run-per-project guard: reject if a run is already active.
  // Runs before any run record / notify / spawn so a rejected start is atomic.
  assertNoActiveWorkflowRun(wf.projectPath);

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
    console.error(`[workflow-run] ${run.id} failed to start step ${firstIndex}:`, err);
    // Through failWorkflowRun, not an inline flip: it keeps a run the user
    // cancelled during setup `cancelled` (the dispatch can throw after the
    // cancel), reclaims any queued/spawned step session, and checkpoints the
    // terminal state immediately instead of via the 100 ms debounce.
    failWorkflowRun(run.id, (err as Error).message ?? 'spawn failed');
    throw err;
  }
}

export function cancelWorkflowRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  // A step still inside its pre-run (an Opengrep scan) has no session to kill;
  // abort the scan so the project's one-scan slot frees for the next run.
  abortStepPreRun(run.id);
  cancelWorkflowStepSessions(run.id);
  cancelStopHookGate(run.id);
  forgetAgentQuiescence(workflowStepAgentId(run.id, run.currentStepIndex));
  // A Run tests step holds the project run lock + a timeout; release both.
  void abortRunTestsStep(run.id);
  notify({ type: 'cancelled', run: snapshot(run) });
  // Durable now, not after the 100 ms debounce: a restart in that window left
  // the run `running` on disk and boot resume re-dispatched a cancelled control
  // step. The run is no longer active, so this write is the mirror's deletion.
  void checkpointWorkflowRun(run).catch(() => {});
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
  forgetAgentQuiescence(workflowStepAgentId(run.id, run.currentStepIndex));
  void abortRunTestsStep(run.id);
  notify({ type: 'errored', run: snapshot(run) });
  void checkpointWorkflowRun(run).catch(() => {});
  console.error(`[workflow-run] ${run.id} errored: ${error}`);
  return true;
}

// Called by the Stop-hook callback. Idempotent: stale hooks (same stepIndex
// re-firing) are silently ignored via the currentStepIndex check.
export async function completeWorkflowStep(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
  deps: AdvanceDeps = {},
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

type AdvanceDeps = {
  killStepSession?: typeof killWorkflowStepSession;
  releaseStepSession?: typeof releaseWorkflowStepSession;
  dispatchStep?: typeof dispatchStep;
  finalizeTestStep?: typeof finalizeRunTestsStep;
};

async function advanceCompletedStep(run: WorkflowRun, stepIndex: number, backendOrigin: string,
  deps: AdvanceDeps): Promise<void> {
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
    // Kill the finished step's pty (the leak/overlap guard) — unless the
    // project keeps step terminals open for inspection, in which case only the
    // bookkeeping is dropped and the idle session stays until its tab closes.
    const keepOpen = await isKeepWorkflowStepTerminalsEnabled(run.projectPath).catch(() => false);
    await (keepOpen
      ? (deps.releaseStepSession ?? releaseWorkflowStepSession)
      : (deps.killStepSession ?? killWorkflowStepSession))(run.id, stepIndex);
    if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
    const wf = run.definition ?? await getWorkflow(run.workflowId);
    if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
    if (!wf) {
      failWorkflowRun(run.id, 'workflow definition not found');
      return;
    }
    // A Run tests step settles here on every path (agent done, skipped, timed
    // out, could not start): its summary lands on the run and its project run
    // lock is released BEFORE the next step dispatches (often Push, a control
    // step that takes the same lock).
    if (wf.steps[stepIndex]?.kind === 'test') {
      await (deps.finalizeTestStep ?? finalizeRunTestsStep)(run, stepIndex);
      if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
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
    console.error(`[workflow-run] ${run.id} advance failed:`, err);
    // failWorkflowRun: durable terminal checkpoint (not the debounce — a
    // restart in that window re-dispatched the failed step) and teardown of
    // whatever the failed dispatch had already queued.
    failWorkflowRun(run.id, (err as Error).message ?? 'advance failed');
  }
}
