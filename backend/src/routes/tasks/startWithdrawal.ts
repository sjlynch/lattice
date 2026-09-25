// Start withdrawal: how an in-flight `startTaskById` (startTask.ts) learns
// that the user cancelled its queued run, deleted the task or re-laned it, and
// how it tears down what it had made — plus the checkout a CAP-rejected pass
// parks for its retry. Split out of startTask.ts, which re-exports the public
// pieces (`isFreshlyRunnable`, `discardOrphanedSpawn`,
// `DiscardOrphanedSpawnDeps`) under their original import path.

import path from 'node:path';
import { getTask, updateTaskWith, type Task, type TaskUpdates } from '../../tasks.js';
import { cleanupWorktreeForTask } from '../../worktree.js';
import { proxyKillSession } from '../../terminalProxy.js';
import { CLEARED_RUN_QUEUE_STATE, TaskStartWithdrawnError } from './queuedSpawnAdmission.js';

// A task can be started from scratch (fresh worktree + agent) when it is
// Open, or In Progress with no worktree on record — the latter happens when a
// task is dragged into the In Progress lane manually without ever running. In
// both cases there is no existing worktree, so setupTaskWorktree creates one.
export function isFreshlyRunnable(task: Task): boolean {
  if (task.status === 'open') return true;
  return task.status === 'in_progress' && !task.worktreePath;
}

// Why an in-flight start must not complete. `deleted`: the task is gone;
// `cancelled`: its queued run was cancelled (signal aborted); `relaned`: the
// task is no longer freshly runnable (dragged to Backlog / Deleted / …, or
// another start already claimed it).
export type Withdrawal = 'deleted' | 'cancelled' | 'relaned';
export type Withdrawn = { withdrawal: Withdrawal; current: Task | null };

export function withdrawalOf(current: Task, signal: AbortSignal | undefined): Withdrawal | null {
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
export function withdrawalUpdates(withdrawal: Withdrawal, current: Task): TaskUpdates | undefined {
  return withdrawal === 'relaned' && hasRunQueueState(current)
    ? { ...CLEARED_RUN_QUEUE_STATE }
    : undefined;
}

// Read the task under its project's write lock and report whether this start
// has been withdrawn. Null means "carry on".
export async function checkWithdrawal(
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

export function withdrawnError(taskId: string, found: Withdrawn): Error {
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

// The teardown (if any) a new start of this task must wait for first.
export function pendingStartTeardown(taskId: string): Promise<void> | undefined {
  return startTeardowns.get(taskId);
}

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
export function discardWithdrawnStart(
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

export function parkCheckoutUntilRetry(
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

export function unparkCheckout(signal: AbortSignal | undefined): void {
  if (!signal) return;
  parkedCheckouts.get(signal)?.();
  parkedCheckouts.delete(signal);
}

// Injectable seam for the teardown below, so the regression test can prove the
// pty kill + worktree cleanup fire without standing up git/terminal-server.
export type DiscardOrphanedSpawnDeps = {
  killSession: (serverId: string) => Promise<unknown>;
  cleanupWorktree: typeof cleanupWorktreeForTask;
};

export const defaultDiscardDeps: DiscardOrphanedSpawnDeps = {
  killSession: proxyKillSession,
  cleanupWorktree: cleanupWorktreeForTask,
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
