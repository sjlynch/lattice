// Shared "start an Open task" helper.
//
// Originally inlined in routes/tasks/runRoute.ts. Extracted so the workflow
// Start control step can drive the same code path the HTTP /run route uses
// (setupTaskWorktree → pre-spawn pty → flip to in_progress) without going
// through an HTTP hop or duplicating the logic.

import path from 'node:path';
import { getTask, updateTaskWith, type Task, type TaskUpdates } from '../../tasks.js';
import { cleanupWorktreeForTask, setupTaskWorktree } from '../../worktree.js';
import { proxyKillSession } from '../../terminalProxy.js';
import { SpawnCapacityError, isSpawnDiskSpaceError } from '../../spawnQueue.js';
import { requestMergeToFreeDiskSpace } from '../../diskPressureMerge.js';
import { normalizeAgentHarness, type AgentHarness } from '../../harnesses.js';
import { normalizePiModel, resolvePiModel } from '../../piModels.js';
import { isCodexYoloEnabled } from '../../userSettings.js';
import { selectHarnessCommand } from './harnessFactory.js';
import { reserveColorSlot, type ColorSlotReservation } from './colorSlot.js';
import { CLEARED_RUN_QUEUE_STATE, TaskStartWithdrawnError } from './queuedSpawnAdmission.js';

// A task can be started from scratch (fresh worktree + agent) when it is
// Open, or In Progress with no worktree on record — the latter happens when a
// task is dragged into the In Progress lane manually without ever running. In
// both cases there is no existing worktree, so setupTaskWorktree creates one.
export function isFreshlyRunnable(task: Task): boolean {
  if (task.status === 'open') return true;
  return task.status === 'in_progress' && !task.worktreePath;
}

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

// Why an in-flight start must not complete. `deleted`: the task is gone;
// `cancelled`: its queued run was cancelled (signal aborted); `relaned`: the
// task is no longer freshly runnable (dragged to Backlog / Deleted / …, or
// another start already claimed it).
type Withdrawal = 'deleted' | 'cancelled' | 'relaned';
type Withdrawn = { withdrawal: Withdrawal; current: Task | null };

function withdrawalOf(current: Task, signal: AbortSignal | undefined): Withdrawal | null {
  if (signal?.aborted) return 'cancelled';
  if (!isFreshlyRunnable(current)) return 'relaned';
  return null;
}

function hasRunQueueState(task: Task): boolean {
  return (Object.keys(CLEARED_RUN_QUEUE_STATE) as Array<keyof typeof CLEARED_RUN_QUEUE_STATE>)
    .some((key) => task[key] !== undefined);
}

// The updates recording a withdrawal. A lane change drops the run's queue
// state (the "Queued" pill, persisted harness, attempt counter) since the run
// is not coming back; a cancel already cleared it, and a re-run may have set
// it again since, so a cancel touches nothing.
function withdrawalUpdates(withdrawal: Withdrawal, current: Task): TaskUpdates | undefined {
  return withdrawal === 'relaned' && hasRunQueueState(current)
    ? { ...CLEARED_RUN_QUEUE_STATE }
    : undefined;
}

// Read the task under its project's write lock and report whether this start
// has been withdrawn. Null means "carry on".
async function checkWithdrawal(
  taskId: string,
  signal: AbortSignal | undefined,
): Promise<Withdrawn | null> {
  const outcome = await updateTaskWith<Withdrawal | null>(taskId, (current) => {
    const withdrawal = withdrawalOf(current, signal);
    return {
      updates: withdrawal ? withdrawalUpdates(withdrawal, current) : undefined,
      result: withdrawal,
    };
  });
  if (!outcome) return { withdrawal: 'deleted', current: null };
  return outcome.result ? { withdrawal: outcome.result, current: outcome.task } : null;
}

function withdrawnError(taskId: string, found: Withdrawn): Error {
  // The task vanished between the queue admitting this run and the status
  // flip (DELETE saw no `worktreePath` yet, so it had nothing to clean up).
  // Kept a plain failure so the UI still hears about it.
  if (found.withdrawal === 'deleted') {
    return new Error(`task ${taskId} was deleted while its run was being started`);
  }
  return new TaskStartWithdrawnError(taskId, found.withdrawal, found.current?.status);
}

// Teardowns of withdrawn starts still running, per task. A new start of the
// same task waits for them: the checkout path is deterministic per task, so a
// `git worktree remove` still in progress would otherwise race the new start's
// `git worktree add` of that same directory.
const startTeardowns = new Map<string, Promise<void>>();

function trackTeardown(taskId: string, work: Promise<void>): Promise<void> {
  const prev = startTeardowns.get(taskId);
  const tracked: Promise<void> = Promise.all([prev, work])
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (startTeardowns.get(taskId) === tracked) startTeardowns.delete(taskId);
    });
  startTeardowns.set(taskId, tracked);
  return tracked;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

// Tear down what a withdrawn start made. If another start of this task already
// recorded this very checkout as its worktree, only our pty is surplus — the
// checkout is theirs now and must survive.
function discardWithdrawnStart(
  task: Pick<Task, 'id' | 'projectPath'>,
  current: Task | null,
  worktree: { worktreePath: string; branch: string },
  serverId: string | undefined,
  deps: DiscardOrphanedSpawnDeps,
): Promise<void> {
  const claimed = !!current?.worktreePath && samePath(current.worktreePath, worktree.worktreePath);
  return trackTeardown(
    task.id,
    claimed
      ? killSurplusPty(task, serverId, deps)
      : discardOrphanedSpawn(task, worktree, serverId, deps),
  );
}

async function killSurplusPty(
  task: Pick<Task, 'id'>,
  serverId: string | undefined,
  deps: DiscardOrphanedSpawnDeps,
): Promise<void> {
  if (!serverId) return;
  await deps.killSession(serverId).catch((err) => {
    console.warn(`[task-run] task ${task.id} start withdrawn; pty ${serverId} kill failed:`, err);
  });
}

// A CAP-rejected pass leaves its checkout behind for the retry to reuse (the
// queue re-runs the thunk; setupTaskWorktree's reconcile makes that
// idempotent). If the queued run is cancelled — or the task deleted — before
// that retry, nothing else would ever reclaim it (DELETE saw no
// `worktreePath`), so the pass parks a teardown on the request's signal. The
// retry detaches it on entry: from then on its own checkpoints own cleanup.
const parkedCheckouts = new WeakMap<AbortSignal, () => void>();

function parkCheckoutUntilRetry(
  task: Pick<Task, 'id' | 'projectPath'>,
  worktree: { worktreePath: string; branch: string },
  signal: AbortSignal | undefined,
  deps: DiscardOrphanedSpawnDeps,
): void {
  if (!signal) return;
  const onAbort = () => {
    parkedCheckouts.delete(signal);
    void trackTeardown(task.id, (async () => {
      const current = await getTask(task.id).catch(() => null);
      await discardWithdrawnStart(task, current, worktree, undefined, deps);
    })());
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  parkedCheckouts.set(signal, () => signal.removeEventListener('abort', onAbort));
}

function unparkCheckout(signal: AbortSignal | undefined): void {
  if (!signal) return;
  parkedCheckouts.get(signal)?.();
  parkedCheckouts.delete(signal);
}

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
// Throws if the task is missing or not in 'open' status — callers that need
// HTTP-style 400/404 responses should handle these cases themselves.
export async function startTaskById(
  taskId: string,
  backendOrigin: string,
  options: StartTaskByIdOptions = {},
): Promise<StartTaskByIdResult> {
  const deps: StartTaskDeps = { ...defaultStartDeps, ...options.deps };
  const { signal } = options;
  // A retry of a CAP-parked pass reuses that checkout — stop guarding it —
  // and a withdrawn earlier start of this task may still be removing it.
  unparkCheckout(signal);
  await startTeardowns.get(taskId);

  const task = await getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (!isFreshlyRunnable(task)) {
    throw new Error(
      `task ${taskId} is "${task.status}" with a worktree, expected a runnable task`,
    );
  }
  if (signal?.aborted) throw new TaskStartWithdrawnError(taskId, 'cancelled');

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
  let result: Awaited<ReturnType<typeof setupTaskWorktree>>;
  try {
    result = await deps.setupTaskWorktree(
      task.projectPath,
      task,
      backendOrigin,
      selectedHarness.harness,
    );
  } catch (err) {
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

  // The flip, as a compare-and-set under the task lock: re-read the task and
  // start it only if it is still freshly runnable and its run not cancelled.
  //
  // Palette slot: keep the task's stored index (a re-run, or a CAP-rejected
  // first pass, must not jump colors) only while no other active task or
  // in-flight reservation holds it — a task that went to QA/Done freed its
  // slot, and a sibling may have taken it since. The reservation covers the
  // sibling starts the spawn queue admits concurrently (up to `softCap`); it
  // is released on every path once the flip has landed or been refused.
  const reservationRef: { current: ColorSlotReservation | null } = { current: null };
  let outcome: { task: Task; result: Withdrawal | null } | null;
  try {
    outcome = await updateTaskWith<Withdrawal | null>(taskId, (current, tasks) => {
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

// Injectable seam for the teardown above, so the regression test can prove the
// pty kill + worktree cleanup fire without standing up git/terminal-server.
export type DiscardOrphanedSpawnDeps = {
  killSession: (serverId: string) => Promise<unknown>;
  cleanupWorktree: typeof cleanupWorktreeForTask;
};

const defaultDiscardDeps: DiscardOrphanedSpawnDeps = {
  killSession: proxyKillSession,
  cleanupWorktree: cleanupWorktreeForTask,
};

const defaultStartDeps: StartTaskDeps = {
  setupTaskWorktree,
  selectHarnessCommand,
  discard: defaultDiscardDeps,
};

// Best-effort teardown of a worktree + pre-spawned pty whose start was
// withdrawn (task deleted, run cancelled, task re-laned) before the
// in_progress flip landed. Kill the pty first so Windows releases its file
// locks, then let `git worktree remove` reclaim the checkout. Never throws —
// the caller raises its own error naming the real cause.
export async function discardOrphanedSpawn(
  task: Pick<Task, 'id' | 'projectPath'>,
  worktree: { worktreePath: string; branch: string },
  serverId: string | undefined,
  deps: DiscardOrphanedSpawnDeps = defaultDiscardDeps,
): Promise<void> {
  if (serverId) {
    await deps.killSession(serverId).catch((err) => {
      console.warn(`[task-run] task ${task.id} start withdrawn; pty ${serverId} kill failed:`, err);
    });
  }
  await deps
    .cleanupWorktree(task.projectPath, worktree.worktreePath, worktree.branch)
    .catch((err) => {
      console.warn(
        `[task-run] task ${task.id} start withdrawn; worktree cleanup deferred to the boot sweep:`,
        err,
      );
    });
}

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
