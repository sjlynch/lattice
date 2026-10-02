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
// Adjacent opted-in planning steps run as a group. Groups and action steps
// remain sequential; a project runs one workflow at a time.
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
import { listTasks } from './tasks.js';
import {
  getActiveRunsForProject,
  notify,
  runs,
  snapshot,
  type WorkflowRun,
  checkpointWorkflowRun,
} from './workflowRuns/state.js';
import { spawnWorkflowStep } from './workflowRuns/stepSpawner.js';
import { activeStepIndices, isWorkflowStepActive, nextStepGroup, openStepGroup,
  setStepPhase, stepPhase } from './workflowRuns/execution.js';
import { runExclusive } from './serializeWrites.js';
import { teardownWorkflowRun } from './workflowRuns/teardown.js';
import { executeControlStep } from './workflowRuns/controlStep.js';
import {
  killWorkflowStepSession,
  releaseWorkflowStepSession,
  workflowStepAgentId,
} from './workflowRuns/sessionSpawner.js';
import { isKeepWorkflowStepTerminalsEnabled } from './userSettings.js';
import { forgetAgentQuiescence } from './agentQuiescence.js';
import { unregisterAgentSession } from './agentSessions.js';
import { cloneWorkflowDefinition } from './workflowRuns/definition.js';
import { beginRestartTransition, trackRestartTransition } from './restartDrain/gate.js';
import {
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
  if (!isWorkflowStepActive(run, stepIndex)) return;
  const kind = wf.steps[stepIndex].kind ?? 'agent';
  if (kind !== 'agent' && activeStepIndices(run).length > 1) throw new Error('action steps cannot run in parallel');
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
  setStepPhase(run, stepIndex, 'running');
  await checkpointWorkflowRun(run);
  if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
  notify({ type: 'progress', run: snapshot(run) });
  // Fire-and-forget. The control step's worker calls completeWorkflowStep
  // when its async work finishes (or marks the run errored on failure).
  executeControlStep(wf, run, stepIndex, backendOrigin, completeWorkflowStep);
}

async function dispatchGroup(wf: Workflow, run: WorkflowRun, backendOrigin: string,
  dispatch: typeof dispatchStep = dispatchStep): Promise<void> {
  const indices = [...activeStepIndices(run)];
  await Promise.all(indices.map(async (index) => {
    try { await dispatch(wf, run, index, backendOrigin); }
    catch (err) {
      if (isWorkflowStepActive(run, index)) {
        if (run.stepStates?.[index]) run.stepStates[index].error = (err as Error).message;
        setStepPhase(run, index, 'errored');
        failWorkflowRun(run.id, `workflow step ${index + 1}: ${(err as Error).message ?? 'setup failed'}`);
      }
      throw err;
    }
  }));
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
  const firstGroup = nextStepGroup(wf.steps, 0);
  if (firstGroup === null) {
    throw new Error('every step in this workflow is frozen');
  }
  const firstIndex = firstGroup.indices[0];

  // Every task already Open belongs to this run's round (the Start step adds
  // the ones it launches), and so does work already In Progress: Merge waits
  // for it rather than leaving it to land in Ready to Merge after the merge,
  // where it would stall a later Push drain. Read before the guard: nothing
  // may await between the guard and the run record, or two starts could both
  // pass it.
  const roundTaskIds = (await listTasks(wf.projectPath))
    .filter((task) => task.status === 'open' || task.status === 'in_progress')
    .map((task) => task.id);

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
    roundTaskIds,
    definition: cloneWorkflowDefinition(wf),
    stepPhase: 'pending',
    ...(harnessOverride ? { harnessOverride } : {}),
    ...(piModelOverride ? { piModelOverride } : {}),
  };
  openStepGroup(run, run.definition!.steps, firstGroup);
  runs.set(run.id, run);
  notify({ type: 'started', run: snapshot(run) });
  console.log(
    `[workflow-run] ${run.id} started (workflow=${wf.id} "${wf.name}", ${wf.steps.length} step(s), override=${harnessOverride ?? 'default'})`,
  );

  // Restart-drain transition: the run exists in memory from here, but only on
  // disk once the checkpoint lands (see ./restartDrain/).
  const endStart = beginRestartTransition(`workflow ${run.id} start`);
  try {
    await checkpointWorkflowRun(run);
    await dispatchGroup(run.definition!, run, backendOrigin);
    return snapshot(run);
  } catch (err) {
    console.error(`[workflow-run] ${run.id} failed to start step ${firstIndex}:`, err);
    // Through failWorkflowRun, not an inline flip: it keeps a run the user
    // cancelled during setup `cancelled` (the dispatch can throw after the
    // cancel), reclaims any queued/spawned step session, and checkpoints the
    // terminal state immediately instead of via the 100 ms debounce.
    failWorkflowRun(run.id, (err as Error).message ?? 'spawn failed');
    throw err;
  } finally {
    endStart();
  }
}

// Tear down all active members after the run leaves `running`.
function teardownActiveStep(run: WorkflowRun): void {
  teardownWorkflowRun(run);
}

export function cancelWorkflowRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  teardownActiveStep(run);
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

// Re-dispatch a control step or a pending agent member after a restart.
// Already-admitted agents are re-adopted instead of replaying their prompts.
export async function redispatchCurrentWorkflowStep(
  runId: string,
  backendOrigin: string,
  stepIndex?: number,
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
    await dispatchStep(wf, run, stepIndex ?? run.currentStepIndex, backendOrigin);
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
  teardownActiveStep(run);
  notify({ type: 'errored', run: snapshot(run) });
  void checkpointWorkflowRun(run).catch(() => {});
  console.error(`[workflow-run] ${run.id} errored: ${error}`);
  return true;
}

// The advance a step-completion callback performs: drop the step's graph node
// + quiescence state, then advance the run (which kills the finishing step's
// pty before dispatching the next one). Shared by the `/complete` route and by
// boot recovery re-arming a Stop the previous process had received but not yet
// acted on (WorkflowRun.stopReceived).
export function workflowStepCompletionAdvance(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
): () => Promise<void> {
  const agentId = workflowStepAgentId(runId, stepIndex);
  return async () => {
    await completeWorkflowStep(runId, stepIndex, backendOrigin);
    unregisterAgentSession(agentId);
    forgetAgentQuiescence(agentId);
  };
}

// In-flight step advances keyed `${runId}:${stepIndex}`, so a re-fired Stop
// hook joins the advance already running instead of starting a second one.
const completions = new Map<string, Promise<void>>();

// Test seams for advanceCompletedStep; each defaults to the real implementation.
type AdvanceDeps = {
  killStepSession?: typeof killWorkflowStepSession;
  releaseStepSession?: typeof releaseWorkflowStepSession;
  dispatchStep?: typeof dispatchStep;
  finalizeTestStep?: typeof finalizeRunTestsStep;
  // Boot can finish the join checkpoint after every member was reclaimed.
  resumeCompleted?: boolean;
};

// Called by the Stop-hook callback. Idempotent: stale hooks (same stepIndex
// re-firing) are silently ignored via the active-member check.
export async function completeWorkflowStep(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
  deps: AdvanceDeps = {},
): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;
  if (run.definitionError) throw new Error(run.definitionError);
  if (!isWorkflowStepActive(run, stepIndex) && !(deps.resumeCompleted &&
    activeStepIndices(run).includes(stepIndex) && run.stepStates?.[stepIndex]?.phase === 'completed')) return;

  const key = `${runId}:${stepIndex}`;
  if (completions.has(key)) return completions.get(key);
  // Tracked for the restart drain: its settle waits for an in-flight advance
  // (checkpoint → teardown → next dispatch) before telling the dev runner the
  // backend may be killed.
  const completing = trackRestartTransition(
    `workflow ${runId} advance from step ${stepIndex}`,
    advanceCompletedStep(run, stepIndex, backendOrigin, deps),
  );
  completions.set(key, completing);
  try { await completing; } finally { if (completions.get(key) === completing) completions.delete(key); }
}

async function advanceCompletedStep(run: WorkflowRun, stepIndex: number, backendOrigin: string,
  deps: AdvanceDeps): Promise<void> {
  const previousPhase = stepPhase(run, stepIndex);
  setStepPhase(run, stepIndex, 'completing');
  try {
    await checkpointWorkflowRun(run);
  } catch (err) {
    if (isWorkflowStepActive(run, stepIndex)) setStepPhase(run, stepIndex, previousPhase ?? 'running');
    throw err;
  }
  try {
    const keepOpen = await isKeepWorkflowStepTerminalsEnabled(run.projectPath).catch(() => false);
    await (keepOpen
      ? (deps.releaseStepSession ?? releaseWorkflowStepSession)
      : (deps.killStepSession ?? killWorkflowStepSession))(run.id, stepIndex);
    if (!isWorkflowStepActive(run, stepIndex)) return;
    const wf = run.definition ?? await getWorkflow(run.workflowId);
    if (!isWorkflowStepActive(run, stepIndex)) return;
    if (!wf) { failWorkflowRun(run.id, 'workflow definition not found'); return; }
    if (wf.steps[stepIndex]?.kind === 'test') {
      await (deps.finalizeTestStep ?? finalizeRunTestsStep)(run, stepIndex);
      if (!isWorkflowStepActive(run, stepIndex)) return;
    }
    // Serialize the durable member settlement and group join. Two last callbacks
    // cannot both dispatch a successor, nor observe an uncheckpointed completion.
    let dispatchNext = false;
    await runExclusive(`workflow-group:${run.id}`, async () => {
      if (!isWorkflowStepActive(run, stepIndex)) return;
      if (run.stepStates) {
        setStepPhase(run, stepIndex, 'completed');
        delete run.stepStates[stepIndex].stopReceived;
        delete run.stepStates[stepIndex].sessionId;
      }
      if (run.stopReceived?.stepIndex === stepIndex) delete run.stopReceived;
      await checkpointWorkflowRun(run);
      if (run.status !== 'running') return;
      if (run.stepStates && activeStepIndices(run).some((i) => run.stepStates![i].phase !== 'completed')) {
        notify({ type: 'progress', run: snapshot(run) });
        return;
      }
      const next = nextStepGroup(wf.steps, run.groupEndIndex ?? stepIndex + 1);
      if (!next) { await completeRun(run, wf); return; }
      openStepGroup(run, wf.steps, next);
      await checkpointWorkflowRun(run);
      notify({ type: 'progress', run: snapshot(run) });
      dispatchNext = true;
    });
    // Dispatch outside the join lock: an unrelated member's pre-run can take
    // minutes, and must not hold callbacks for the new group's other members.
    if (dispatchNext && run.status === 'running') {
      await dispatchGroup(wf, run, backendOrigin, deps.dispatchStep ?? dispatchStep);
    }
  } catch (err) {
    if (run.status !== 'running') return;
    failWorkflowRun(run.id, (err as Error).message ?? 'advance failed');
  }
}

// Finish a run whose last runnable step just completed.
async function completeRun(run: WorkflowRun, wf: Workflow): Promise<void> {
  // Park the index past the last step so every editor row reads as done.
  // `max` keeps a claim that already overshot (workflow shortened mid-run).
  run.currentStepIndex = Math.max(run.currentStepIndex, wf.steps.length);
  run.activeStepIndices = [];
  run.status = 'completed';
  run.finishedAt = Date.now();
  console.log(`[workflow-run] ${run.id} completed all ${wf.steps.length} step(s)`);
  notify({ type: 'completed', run: snapshot(run) });
  await checkpointWorkflowRun(run);
}
