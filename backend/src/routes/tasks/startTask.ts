// Shared "start an Open task" helper.
//
// Originally inlined in routes/tasks/runRoute.ts. Extracted so the workflow
// Start control step can drive the same code path the HTTP /run route uses
// (setupTaskWorktree → pre-spawn pty → flip to in_progress) without going
// through an HTTP hop or duplicating the logic.
//
// The withdrawal checks, teardown and checkout parking a start relies on live
// in startWithdrawal.ts.

import { getTask, updateTaskWith, type Task, type TaskUpdates } from '../../tasks.js';
import { setupTaskWorktree } from '../../worktree.js';
import { SpawnCapacityError, isSpawnDiskSpaceError } from '../../spawnQueue.js';
import { requestMergeToFreeDiskSpace } from '../../diskPressureMerge.js';
import { normalizeAgentHarness, type AgentHarness } from '../../harnesses.js';
import { normalizePiModel, resolvePiModel } from '../../piModels.js';
import { isCodexYoloEnabled } from '../../userSettings.js';
import {
  selectHarnessCommand,
  type CreateSessionOutcome,
  type SelectedHarnessCommand,
} from './harnessFactory.js';
import { reserveColorSlot, type ColorSlotReservation } from './colorSlot.js';
import { CLEARED_RUN_QUEUE_STATE, TaskStartWithdrawnError } from './queuedSpawnAdmission.js';
import {
  checkWithdrawal,
  defaultDiscardDeps,
  discardWithdrawnStart,
  isFreshlyRunnable,
  parkCheckoutUntilRetry,
  pendingStartTeardown,
  unparkCheckout,
  withdrawalOf,
  withdrawalUpdates,
  withdrawnError,
  type DiscardOrphanedSpawnDeps,
  type Withdrawal,
  type Withdrawn,
} from './startWithdrawal.js';

export {
  discardOrphanedSpawn,
  isFreshlyRunnable,
  type DiscardOrphanedSpawnDeps,
} from './startWithdrawal.js';

export type StartTaskByIdResult = {
  task: Task;
  worktreePath: string;
  branch: string;
  taskFile: string;
  command: string;
  serverId?: string;
  terminalId?: string;
};

// The heavy I/O a start does, injectable so the withdrawal checkpoints can be
// exercised without git or the terminal-server. Production wires the real ones.
export type StartTaskDeps = {
  setupTaskWorktree: typeof setupTaskWorktree;
  selectHarnessCommand: typeof selectHarnessCommand;
  discard: DiscardOrphanedSpawnDeps;
};

export type StartTaskByIdOptions = {
  requestedHarness?: unknown;
  // Explicit Pi model from the run request body. Falls back to the per-project
  // default (UserSettings.piModel) when absent. Ignored unless harness is `pi`.
  requestedPiModel?: unknown;
  // When true, a terminal-server hard-cap rejection throws SpawnCapacityError
  // and the task is left 'open' (so the spawn-queue thunk is re-runnable).
  // When false/omitted, a cap rejection is swallowed: the task still flips to
  // in_progress with no pre-spawned pty (the un-queued control-step path).
  throwOnCapacity?: boolean;
  // The spawn-queue request's signal (queued runs only). Aborted when the
  // user cancels the queued run or deletes the task while this start is
  // already in flight; the start then backs out instead of flipping the task.
  signal?: AbortSignal;
  deps?: Partial<StartTaskDeps>;
};

type WorktreeSetup = Awaited<ReturnType<typeof setupTaskWorktree>>;

// Run an Open task: set up the worktree, pre-spawn the harness pty, then flip
// status to in_progress. Returns the spawn info so callers can either surface
// it (HTTP route → UI terminal) or discard it (control step → terminal is
// pre-warmed for when the user clicks into the task card).
//
// The status flip happens AFTER the pty spawn so a CAP-rejected spawn (with
// throwOnCapacity) leaves the task 'open': the spawn-queue re-runs this whole
// function, and setupTaskWorktree's reconcileStaleState makes the second pass
// idempotent against the worktree the first pass already created.
//
// The checkout can take minutes (checkout gate, disk estimate), and meanwhile
// the user can cancel the queued run, delete the task or drag it to another
// lane. Their change wins: the start re-checks after the checkout, before a
// CAP re-queue, and — as a compare-and-set under the task lock — at the final
// flip. A withdrawn start tears down its worktree + pty and throws
// (TaskStartWithdrawnError, or a plain Error when the task was deleted).
//
// At most one start per task runs at a time, whatever the entry point (the
// spawn queue's /run thunk, the workflow Start step's direct call, …): a
// second concurrent start waits for the first to settle, then re-checks the
// task — see startTaskExclusive.
//
// Throws if the task is missing or not in 'open' status — callers that need
// HTTP-style 400/404 responses should handle these cases themselves.
export function startTaskById(
  taskId: string,
  backendOrigin: string,
  options: StartTaskByIdOptions = {},
): Promise<StartTaskByIdResult> {
  // Registered synchronously, before any await, so two calls in the same
  // tick are already serialized.
  const prior = startsInFlight.get(taskId);
  const start = (async () => {
    if (prior) await prior;
    return startTaskExclusive(taskId, backendOrigin, options, prior !== undefined);
  })();
  const settled: Promise<void> = start
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (startsInFlight.get(taskId) === settled) startsInFlight.delete(taskId);
    });
  startsInFlight.set(taskId, settled);
  return start;
}

// Starts in flight, per task: each entry settles when the latest start of that
// task does (a third start chains behind the second). Without this, the
// workflow Start step's direct start and a /run (Run All, ▶, MCP run_task)
// admitted while the first still waited on the checkout gate — the task is
// `open` until the flip, so it passes isFreshlyRunnable — both set up the same
// worktree path: the second setup's reconcile killed the first agent's pty
// and recreated the checkout, and the second then backed out, stranding the
// task In Progress with no agent.
const startsInFlight = new Map<string, Promise<void>>();

// Is a start of this task running (or waiting behind another start of it)?
export function isTaskStartInFlight(taskId: string): boolean {
  return startsInFlight.has(taskId);
}

async function startTaskExclusive(
  taskId: string,
  backendOrigin: string,
  options: StartTaskByIdOptions,
  waitedForConcurrentStart: boolean,
): Promise<StartTaskByIdResult> {
  const deps: StartTaskDeps = { ...defaultStartDeps, ...options.deps };
  const { signal } = options;
  // A retry of a CAP-parked pass reuses that checkout — stop guarding it —
  // and a withdrawn earlier start of this task may still be removing it.
  unparkCheckout(signal);
  await pendingStartTeardown(taskId);

  // The start we waited for claimed the task (or it was re-laned / cancelled
  // meanwhile): this one is surplus. Withdraw before touching the worktree —
  // it now belongs to the live agent. A failed or withdrawn earlier start left
  // the task runnable, so this start carries on as an ordinary retry.
  if (waitedForConcurrentStart) {
    const found = await checkWithdrawal(taskId, signal);
    if (found) throw withdrawnError(taskId, found);
  }

  const task = await getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (!isFreshlyRunnable(task)) {
    throw new Error(
      `task ${taskId} is "${task.status}" with a worktree, expected a runnable task`,
    );
  }
  if (signal?.aborted) throw new TaskStartWithdrawnError(taskId, 'cancelled');

  const { selectedHarness, piModel } = await resolveStartHarness(task, options, deps);
  let result: WorktreeSetup;
  try {
    result = await deps.setupTaskWorktree(
      task.projectPath,
      task,
      backendOrigin,
      selectedHarness.harness,
    );
  } catch (err) {
    // Cancelled while the checkout ran (it can wait minutes for a checkout
    // slot before the disk guard even looks): whatever it failed with, the
    // start is withdrawn. Otherwise a disk deferral would have `runSpawnThunk`
    // stamp `runWaitingForDisk` on a task whose run the user already cancelled.
    if (signal?.aborted) throw new TaskStartWithdrawnError(taskId, 'cancelled');
    // No room for another checkout: the task stays Open and the spawn queue
    // retries it. Ask for a merge run so parked Ready-to-Merge worktrees give
    // their space back (gated + throttled — see diskPressureMerge.ts).
    if (isSpawnDiskSpaceError(err)) requestMergeToFreeDiskSpace(task.projectPath, backendOrigin);
    throw err;
  }
  const backOut = async (found: Withdrawn, serverId: string | undefined): Promise<never> => {
    await discardWithdrawnStart(task, found.current, result, serverId, deps.discard);
    throw withdrawnError(taskId, found);
  };

  // Withdrawn while the checkout ran: don't spawn an agent at all.
  const beforeSpawn = await checkWithdrawal(taskId, signal);
  if (beforeSpawn) return backOut(beforeSpawn, undefined);

  const spawn = await selectedHarness.createSession({
    taskFile: result.taskFile,
    cwd: result.worktreePath,
  });
  if (spawn.capHit && options.throwOnCapacity) {
    // No pty was created. A withdrawn start must not be re-queued with its
    // checkout still on disk; otherwise park the checkout for the retry.
    const beforeRequeue = await checkWithdrawal(taskId, signal);
    if (beforeRequeue) return backOut(beforeRequeue, undefined);
    parkCheckoutUntilRetry(task, result, signal, deps.discard);
    throw new SpawnCapacityError(
      `task ${taskId}: no terminal slot (terminal-server hard cap)`,
    );
  }

  const outcome = await flipToInProgress(taskId, signal, result, spawn, selectedHarness, piModel);
  if (!outcome) return backOut({ withdrawal: 'deleted', current: null }, spawn.serverId);
  if (outcome.result) {
    return backOut({ withdrawal: outcome.result, current: outcome.task }, spawn.serverId);
  }

  return {
    task: outcome.task,
    worktreePath: result.worktreePath,
    branch: result.branch,
    taskFile: result.taskFile,
    command: spawn.command,
    serverId: spawn.serverId,
    terminalId: spawn.terminalId,
  };
}

// Pick the harness command a run spawns with.
async function resolveStartHarness(
  task: Task,
  options: StartTaskByIdOptions,
  deps: StartTaskDeps,
): Promise<{ selectedHarness: SelectedHarnessCommand; piModel: string | undefined }> {
  // Resolve the Pi model only for a Pi run: explicit request body wins, else
  // the per-project default. Avoids a settings read for Claude/Codex tasks.
  const harness = normalizeAgentHarness(options.requestedHarness);
  const piModel =
    harness === 'pi'
      ? normalizePiModel(options.requestedPiModel) ??
        (await resolvePiModel(task.projectPath))
      : undefined;
  // Resolve the Codex `--yolo` toggle only for a Codex run (default ON).
  const codexYolo =
    harness === 'codex' ? await isCodexYoloEnabled(task.projectPath) : undefined;
  const selectedHarness = deps.selectHarnessCommand(task, {
    requestedHarness: options.requestedHarness,
    mode: 'run',
    piModel,
    codexYolo,
  });
  return { selectedHarness, piModel };
}

// The flip, as a compare-and-set under the task lock: re-read the task and
// start it only if it is still freshly runnable and its run not cancelled.
// Null when the task is gone; otherwise `result` is the withdrawal that
// refused the flip, or null when it landed.
//
// Palette slot: keep the task's stored index (a re-run, or a CAP-rejected
// first pass, must not jump colors) only while no other active task or
// in-flight reservation holds it — a task that went to QA/Done freed its
// slot, and a sibling may have taken it since. The reservation covers the
// sibling starts the spawn queue admits concurrently (up to `softCap`); it
// is released on every path once the flip has landed or been refused.
async function flipToInProgress(
  taskId: string,
  signal: AbortSignal | undefined,
  result: WorktreeSetup,
  spawn: CreateSessionOutcome,
  selectedHarness: SelectedHarnessCommand,
  piModel: string | undefined,
): Promise<{ task: Task; result: Withdrawal | null } | null> {
  const reservationRef: { current: ColorSlotReservation | null } = { current: null };
  try {
    return await updateTaskWith<Withdrawal | null>(taskId, (current, tasks) => {
      const withdrawal = withdrawalOf(current, signal);
      if (withdrawal) {
        return { updates: withdrawalUpdates(withdrawal, current), result: withdrawal };
      }
      const reservation = reserveColorSlot(
        current.projectPath,
        tasks,
        current.id,
        current.colorIndex,
      );
      reservationRef.current = reservation;
      return { updates: startedUpdates(reservation.slot), result: null };
    });
  } finally {
    reservationRef.current?.release();
  }

  function startedUpdates(slot: number): TaskUpdates {
    return {
      status: 'in_progress',
      worktreePath: result.worktreePath,
      branch: result.branch,
      startedAt: Date.now(),
      harness: selectedHarness.harness,
      // Persist the model used so a resume re-spawns with the same one.
      piModel: selectedHarness.harness === 'pi' ? piModel : undefined,
      colorIndex: slot,
      // The pinned harness conversation (Claude / Pi); a Codex id lands later
      // via the registry's rollout discovery (resumeTask reads the registry).
      agentSession: spawn.agentSession
        ? { harness: spawn.agentSession.harness, id: spawn.agentSession.id }
        : undefined,
      // The run finally spawned — drop the queued badge, the persisted execution
      // policy, and the attempt counter so a later re-run isn't gated by boot
      // recovery's retry ceiling.
      ...CLEARED_RUN_QUEUE_STATE,
    };
  }
}

const defaultStartDeps: StartTaskDeps = {
  setupTaskWorktree,
  selectHarnessCommand,
  discard: defaultDiscardDeps,
};

// Convenience for callers that already have a harness string (e.g. workflow
// runs that resolved the override at run start). Just a typed alias around
// the option above.
export async function startTaskByIdWithHarness(
  taskId: string,
  backendOrigin: string,
  harness: AgentHarness,
): Promise<StartTaskByIdResult> {
  return startTaskById(taskId, backendOrigin, { requestedHarness: harness });
}
