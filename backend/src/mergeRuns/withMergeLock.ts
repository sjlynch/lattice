import { release, tryAcquire, type MergeLockToken } from '../mergeLocks.js';
import { type Task } from '../tasks.js';
import type { MergeRun } from './state.js';
import type { ProcessOutcome } from './processTarget.js';

// Shared per-task merge-lock lifecycle for the merge-run worker.
//
// Both processTarget and flaggedConflict's tryFinalizeAfterResolverFinished
// need the same shape around a task's in-worktree merge: tryAcquire, and on
// failure record the "lock held" error and bail; on success run the work under
// a try/finally that releases the lock — UNLESS the work handed the lock off
// early (an 'awaiting-resolver' outcome parked on the conflict waiter, which
// releases the lock itself via parkOnConflictResolver). The catch records an
// errored run entry and yields an 'errored' outcome.
//
// Callers differ only in what they do when the lock is unavailable
// (processTarget bumps `processed` and skips the task; flaggedConflict feeds an
// 'errored' outcome into the integrity check), so the helper reports that as a
// distinct result and leaves the follow-up to the caller.

export type WithMergeLockResult =
  | { kind: 'lock-unavailable' }
  | { kind: 'ran'; outcome: ProcessOutcome };

export async function withMergeLock(
  task: Task,
  run: MergeRun,
  errorContext: string,
  work: (lock: MergeLockToken) => Promise<ProcessOutcome>,
): Promise<WithMergeLockResult> {
  const lock = tryAcquire(task.id);
  if (!lock) {
    console.warn(`[merge-run] task ${task.id} lock held — skipping`);
    run.errored.push({
      taskId: task.id,
      error: 'merge lock held by another caller; skipped',
    });
    return { kind: 'lock-unavailable' };
  }

  let outcome: ProcessOutcome;
  let lockHeld = true;
  try {
    outcome = await work(lock);
    // The work parked on the conflict resolver, which already released the
    // lock (parkOnConflictResolver). Don't release it again in the finally.
    if (outcome.kind === 'awaiting-resolver') lockHeld = false;
  } catch (err) {
    console.error(`[merge-run] uncaught error ${errorContext} ${task.id}:`, err);
    run.errored.push({
      taskId: task.id,
      error: (err as Error).message ?? 'unknown error',
    });
    outcome = { kind: 'errored' };
  } finally {
    if (lockHeld) release(lock);
  }

  return { kind: 'ran', outcome };
}
