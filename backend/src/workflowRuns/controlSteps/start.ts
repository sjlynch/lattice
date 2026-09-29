// 'start' control step — run every Open task.
//
// Moves every Open task to In Progress and runs each (same code path as the
// Task Board "Run All" button), emitting one terminal tab per task so the
// user can watch / intervene.

import { listTasks, type Task } from '../../tasks.js';
import {
  isTaskStartInFlight,
  startTaskById,
  type StartTaskByIdResult,
} from '../../routes/tasks/startTask.js';
import { unparkCheckout } from '../../routes/tasks/startWithdrawal.js';
import { enqueueTaskRun, taskRunDedupeKey } from '../../routes/tasks/queuedSpawn.js';
import {
  batchAdmissionHold,
  hasSpawnRequest,
  isSpawnDeferral,
  isSpawnDiskSpaceError,
} from '../../spawnQueue.js';
import type { AgentHarness } from '../../harnesses.js';
import type { Workflow } from '../../workflows.js';
import { notify, subscribe, type WorkflowRun } from '../state.js';
import { emitControlProgress } from './shared.js';
import { resolveStartStepHarnessPicker } from './startHarness.js';

export {
  startStepTaskPiModel,
  resolveStartStepHarnessPicker,
  type StartStepTaskHarness,
} from './startHarness.js';

// Injectable seam (production default below). Mirrors merge.ts's MergeStepDeps:
// the hard-cap handling (Fix 1) is the subtle part, so the regression test
// overrides `startTask` to simulate a terminal-server cap rejection without
// spawning a real worktree/pty and asserts the capped task is neither counted
// as started nor left in_progress-without-agent.
export type StartStepDeps = {
  listTasks: typeof listTasks;
  startTask: typeof startTaskById;
  enqueueRun: typeof enqueueTaskRun;
  // Why a batch spawn would be held right now (agent cap / resource
  // governor), or null. Optional so hand-built test deps keep compiling.
  admissionHold?: () => Promise<string | null>;
  // Does the spawn queue hold a run for this task (pending or in flight)?
  // Optional so hand-built test deps keep compiling.
  hasQueuedRun?: (taskId: string) => boolean;
  // Is a startTaskById of this task running right now (whatever started it)?
  // Optional so hand-built test deps keep compiling.
  hasStartInFlight?: (taskId: string) => boolean;
  // Observe workflow end/advance while a direct launch is still in flight.
  subscribeRun?: typeof subscribe;
};

const productionDeps: StartStepDeps = {
  listTasks,
  startTask: startTaskById,
  enqueueRun: enqueueTaskRun,
  admissionHold: batchAdmissionHold,
  hasQueuedRun: (taskId) => hasSpawnRequest(taskRunDedupeKey(taskId)),
  hasStartInFlight: isTaskStartInFlight,
};

// A task whose run is already queued or being started (Run All, a manual ▶, a
// boot re-enqueue) must not be started again here. A queued run keeps the task
// `open` until its pty spawns — which on a big repo can be minutes of waiting
// on the checkout gate — so it passes startTaskById's freshly-runnable check,
// and the second setup's reconcile would kill the first run's pty and
// force-remove its worktree (or, once the first agent had committed, leave two
// live agents on one task). `runQueued` covers the persisted flag (incl. the
// boot window before queuedRunResume re-enqueues it); the live queue lookup
// covers a run enqueued after this step listed the tasks, and the in-flight
// start lookup any other direct start. (The reverse — a /run admitted while
// THIS step's start waits on the checkout gate — is serialized inside
// startTaskById itself: the later start waits, then withdraws.)
function runAlreadyQueued(task: Task, deps: StartStepDeps): boolean {
  return (
    task.runQueued === true ||
    deps.hasQueuedRun?.(task.id) === true ||
    deps.hasStartInFlight?.(task.id) === true
  );
}

// Task titles are clipped to this many characters in the step's log lines.
const LOG_TITLE_CHARS = 60;

function logTitle(task: Task): string {
  return task.title.slice(0, LOG_TITLE_CHARS);
}

// Running per-outcome counts for one Start step, reported as progress after
// every task.
type StartTally = {
  started: number;
  failed: number;
  // Tasks that hit the terminal-server hard cap: left Open and re-queued on the
  // spawn queue rather than force-flipped to in_progress with no agent (Fix 1).
  // They are NOT counted as started (there is no live agent yet) and NOT as
  // failed (a cap rejection isn't an error — the queue will start them when a
  // slot frees). Tracked separately so the "no progress" throw below can tell a
  // genuinely-failed run from one that merely overflowed the cap.
  deferred: number;
  firstError: string | null;
};

function emitStartProgress(
  run: WorkflowRun,
  stepIndex: number,
  tally: StartTally,
  total: number,
): void {
  emitControlProgress(
    run,
    stepIndex,
    'start',
    tally.started + tally.failed + tally.deferred,
    total,
    startProgressMessage(total, tally.started, tally.failed, tally.deferred),
  );
}

// What `startOneTask` needs from the surrounding step besides the task itself.
type StartOneTaskContext = {
  wf: Workflow;
  run: WorkflowRun;
  stepIndex: number;
  backendOrigin: string;
  deps: StartStepDeps;
};

type StartOneTaskResult =
  | { outcome: 'started' }
  | { outcome: 'deferred' }
  | { outcome: 'withdrawn' }
  | { outcome: 'failed'; error: string };

function isCurrentStartStep(run: WorkflowRun, stepIndex: number): boolean {
  return run.status === 'running' && run.currentStepIndex === stepIndex;
}

// Own only this direct launch, until startTaskById establishes it or rejects.
// Never cancel by task-run dedupe key: that request may belong to another
// caller. Accepted queue admissions and established agents have their own
// lifecycle after this Start step ends.
async function startTaskForStep(
  task: Task,
  harness: AgentHarness,
  piModel: string | undefined,
  ctx: StartOneTaskContext,
): Promise<StartTaskByIdResult | null> {
  const { run, stepIndex, backendOrigin, deps } = ctx;
  const controller = new AbortController();
  const unsubscribe = (deps.subscribeRun ?? subscribe)((ev) => {
    if ('run' in ev && ev.run.id === run.id && !isCurrentStartStep(ev.run, stepIndex)) {
      controller.abort();
    }
  });
  try {
    if (!isCurrentStartStep(run, stepIndex)) controller.abort();
    if (controller.signal.aborted) return null;
    const spawned = await deps.startTask(task.id, backendOrigin, {
      requestedHarness: harness,
      requestedPiModel: piModel,
      throwOnCapacity: true,
      signal: controller.signal,
    });
    return controller.signal.aborted || !isCurrentStartStep(run, stepIndex) ? null : spawned;
  } catch (err) {
    if (controller.signal.aborted || !isCurrentStartStep(run, stepIndex)) return null;
    throw err;
  } finally {
    if (!isCurrentStartStep(run, stepIndex)) controller.abort();
    unsubscribe();
    // A CAP-rejected direct start parks its checkout on this signal. Handing
    // it to enqueueTaskRun transfers retry ownership to the queue's signal;
    // our old signal must not reclaim a checkout its retry is now using.
    unparkCheckout(controller.signal);
  }
}

// One task of the Start step: admission hold → already-queued → startTask →
// `workflow-task-spawned` notify, classified as started, deferred (left to the
// spawn queue) or failed (with its error message).
async function startOneTask(
  task: Task,
  harness: AgentHarness,
  piModel: string | undefined,
  ctx: StartOneTaskContext,
): Promise<StartOneTaskResult> {
  const { wf, run, stepIndex, backendOrigin, deps } = ctx;
  // Hand the task to the spawn queue, then warn why. `queueFailure` names the
  // enqueue in its error line; `reason` finishes the warning.
  const requeue = async (queueFailure: string, reason: string): Promise<StartOneTaskResult> => {
    if (!isCurrentStartStep(run, stepIndex)) return { outcome: 'withdrawn' };
    if (runAlreadyQueued(task, deps)) return { outcome: 'deferred' };
    try {
      await deps.enqueueRun(task.id, backendOrigin, harness, piModel);
    } catch (enqErr) {
      if (!isCurrentStartStep(run, stepIndex)) return { outcome: 'withdrawn' };
      console.error(
        `[workflow-run] ${run.id} start step: failed to ${queueFailure} ${task.id}:`,
        enqErr,
      );
      return { outcome: 'failed', error: enqErr instanceof Error ? enqErr.message : String(enqErr) };
    }
    if (!isCurrentStartStep(run, stepIndex)) return { outcome: 'withdrawn' };
    console.warn(
      `[workflow-run] ${run.id} start step: task ${task.id} ("${logTitle(task)}") ${reason}`,
    );
    return { outcome: 'deferred' };
  };

  // Starting directly bypasses the spawn queue, and with it the
  // maxConcurrentAgents cap and the CPU/RAM governor: a 50-task Start step
  // used to launch 50 agents at once. When the queue would hold a batch
  // spawn right now, hand the task to it instead (the same deferral a cap
  // rejection takes below) — it starts as soon as capacity returns.
  const hold = await deps.admissionHold?.();
  if (!isCurrentStartStep(run, stepIndex)) return { outcome: 'withdrawn' };
  // Already being started by the spawn queue: leave it to that run. Counted
  // as deferred — it is queued forward progress, not a failure. Checked after
  // the admission-hold await, which polls the terminal-server, so a run
  // enqueued meanwhile is seen too, even if admission is now held.
  if (runAlreadyQueued(task, deps)) {
    console.log(
      `[workflow-run] ${run.id} start step: task ${task.id} ("${logTitle(task)}") ` +
        'already has a queued run — leaving it to the spawn queue',
    );
    return { outcome: 'deferred' };
  }
  if (hold) {
    return requeue('queue task', `queued instead of started — ${hold}`);
  }
  try {
    // startTaskById only succeeds after a terminal allocation. CAP rejects
    // with SpawnCapacityError for deferral below; all other allocation errors
    // become failed outcomes. Keep the legacy option explicit for callers.
    const spawned = await startTaskForStep(task, harness, piModel, ctx);
    if (!spawned || !isCurrentStartStep(run, stepIndex)) return { outcome: 'withdrawn' };
    // Surface the spawned task agent as a terminal tab. Without this,
    // the pty is pre-warmed but no UI tab is ever attached, so the
    // user can't watch the agent run or intervene if it stalls.
    // Frontend useTaskTerminalCleanup auto-closes by taskId on lane
    // transition (when TaskBoard is mounted).
    notify({
      type: 'workflow-task-spawned',
      runId: run.id,
      projectPath: wf.projectPath,
      stepIndex,
      taskId: spawned.task.id,
      title: spawned.task.title,
      command: spawned.command,
      cwd: spawned.worktreePath,
      serverId: spawned.serverId,
      terminalId: spawned.terminalId,
    });
    console.log(
      `[workflow-run] ${run.id} start step: task ${task.id} ("${logTitle(task)}") → in_progress`,
    );
    return { outcome: 'started' };
  } catch (err) {
    if (!isCurrentStartStep(run, stepIndex)) return { outcome: 'withdrawn' };
    if (isSpawnDeferral(err)) {
      // Hard cap: startTaskById threw BEFORE flipping status, so the task is
      // still Open (no phantom in_progress, no orphan pty). Re-enqueue it on
      // the spawn queue — the same path Run All uses — so it starts when a
      // slot frees. Don't count it as started or failed.
      // A disk-space deferral takes the same path: no worktree was created,
      // the task is still Open, and the queue starts it once there is room.
      return requeue(
        're-queue capped task',
        isSpawnDiskSpaceError(err)
          ? `is waiting for disk space (${err.message}) — left Open and re-queued on the spawn queue`
          : 'hit the terminal-server hard cap — left Open and re-queued on the spawn queue',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    // console.error (not warn): a task that can't be started is the whole
    // point of this step failing — make it loud in the backend log.
    console.error(
      `[workflow-run] ${run.id} start step: task ${task.id} ("${logTitle(task)}") failed to start:`,
      err,
    );
    return { outcome: 'failed', error: message };
  }
}

export async function runStartStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  deps: StartStepDeps = productionDeps,
): Promise<void> {
  if (!isCurrentStartStep(run, stepIndex)) return;
  const tasks = await deps.listTasks(wf.projectPath);
  if (!isCurrentStartStep(run, stepIndex)) return;
  const open = tasks
    .filter((t) => t.status === 'open')
    .sort((a, b) => a.createdAt - b.createdAt);

  if (open.length === 0) {
    console.log(
      `[workflow-run] ${run.id} start step: no open tasks for ${wf.projectPath} — skipping`,
    );
    emitControlProgress(run, stepIndex, 'start', 0, 0, 'no open tasks; skipping');
    return;
  }

  console.log(
    `[workflow-run] ${run.id} start step: moving ${open.length} open task(s) → in_progress`,
  );
  // Resolve the harness/Pi-model the same way the Task Board "Run All" button
  // does — a run-level override pins every task, otherwise the per-project
  // default harness applies (interleave expands to a claude/pi mix). Resolved
  // once here, applied per task below.
  const pickHarness = await resolveStartStepHarnessPicker(run, wf.projectPath);
  if (!isCurrentStartStep(run, stepIndex)) return;
  const tally: StartTally = { started: 0, failed: 0, deferred: 0, firstError: null };
  emitControlProgress(
    run,
    stepIndex,
    'start',
    0,
    open.length,
    `starting ${open.length} task(s)`,
  );

  const ctx: StartOneTaskContext = { wf, run, stepIndex, backendOrigin, deps };
  for (const [index, task] of open.entries()) {
    if (!isCurrentStartStep(run, stepIndex)) return;
    const { harness, piModel } = pickHarness(index);
    const result = await startOneTask(task, harness, piModel, ctx);
    if (result.outcome === 'withdrawn' || !isCurrentStartStep(run, stepIndex)) return;
    if (result.outcome === 'started') {
      tally.started += 1;
    } else if (result.outcome === 'deferred') {
      tally.deferred += 1;
    } else {
      tally.failed += 1;
      if (tally.firstError === null) tally.firstError = result.error;
    }
    emitStartProgress(run, stepIndex, tally, open.length);
  }
  if (!isCurrentStartStep(run, stepIndex)) return;
  const { started, failed, deferred, firstError } = tally;

  // If the step had open tasks but moved NONE of them forward — neither started
  // nor re-queued — and something genuinely failed, it accomplished nothing:
  // throw so the workflow errors with the real underlying message (e.g. a
  // worktree-creation failure) instead of silently advancing to merge/push,
  // which then find nothing to do and the whole run "succeeds" having done no
  // work. A cap-deferred task IS forward progress (it's queued), so a run that
  // only overflowed the cap must not throw here.
  if (started === 0 && deferred === 0 && failed > 0) {
    throw new Error(
      `start step: all ${failed} task(s) failed to move from open → in_progress. ` +
        `First failure: ${firstError ?? 'unknown error'}`,
    );
  }
  // Partial failure: the started tasks still proceed; just log it loudly so
  // the dropped tasks aren't invisible.
  if (failed > 0) {
    console.warn(
      `[workflow-run] ${run.id} start step finished with ${started} started, ${failed} failed — ` +
        `the ${failed} failed task(s) remain in the open lane`,
    );
  }
  // Deferred tasks are queued, not dropped — but note them so the overflow
  // isn't invisible either.
  if (deferred > 0) {
    console.warn(
      `[workflow-run] ${run.id} start step: ${deferred} task(s) were left to the spawn ` +
        `queue (already queued, held by the agent cap / governor, or waiting on the ` +
        `hard cap or disk space) — they start as slots free`,
    );
  }
}

function startProgressMessage(
  total: number,
  started: number,
  failed: number,
  deferred: number,
): string {
  let msg = `${started}/${total} started`;
  if (failed > 0) msg += `, ${failed} failed`;
  if (deferred > 0) msg += `, ${deferred} queued`;
  return msg;
}
