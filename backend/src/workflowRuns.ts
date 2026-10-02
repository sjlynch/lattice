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
//   - dispatch.ts      kind-dispatch of a step / group
//   - advance.ts       step completion + advance to the next group
//   - failRun.ts       failWorkflowRun
// This file owns just the orchestration: start, cancel, restart recovery.

import {
  getWorkflow,
  normalizeWorkflowRunHarnessOverride,
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
import { nextStepGroup, openStepGroup } from './workflowRuns/execution.js';
import { teardownWorkflowRun } from './workflowRuns/teardown.js';
import { cloneWorkflowDefinition } from './workflowRuns/definition.js';
import { beginRestartTransition } from './restartDrain/gate.js';
import { dispatchGroup, dispatchStep } from './workflowRuns/dispatch.js';
import { completeWorkflowStep } from './workflowRuns/advance.js';
import { failWorkflowRun } from './workflowRuns/failRun.js';

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
export {
  workflowStepCompletionAdvance,
  completeWorkflowStep,
} from './workflowRuns/advance.js';
export { failWorkflowRun } from './workflowRuns/failRun.js';

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
    await dispatchGroup(run.definition!, run, backendOrigin, completeWorkflowStep);
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
    await dispatchStep(wf, run, stepIndex ?? run.currentStepIndex, backendOrigin, completeWorkflowStep);
  } catch (err) {
    failWorkflowRun(runId, (err as Error).message ?? 'resume failed');
  }
}

