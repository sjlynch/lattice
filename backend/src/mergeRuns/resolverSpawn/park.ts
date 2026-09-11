import { release, type MergeLockToken } from '../../mergeLocks.js';
import { type RunState } from '../state.js';
import {
  awaitResolverWaiter,
  type WaiterReleaseReason,
} from '../waiterLiveness.js';

// Park the merge-run worker on the conflict waiter for `taskId` until the
// resolver's Stop hook signals it — WITHOUT holding the per-task merge lock.
//
// The caller (processTarget / tryFinalizeAfterResolverFinished) acquired that
// lock to serialize the in-worktree git merge that produced this conflict. By
// the time we reach the wait that git work is done; from here we only block on
// the resolver. We MUST drop the lock before waiting, because the resolver's
// /complete -> finalizeResolvedTask takes the SAME per-task lock to re-sync, FF
// main, and signal this very waiter. Parking while still holding it makes that
// finalize lose the tryAcquire race, return 'already-finalizing' WITHOUT
// signalling, and this promise never resolves — deadlocking the run (and
// stranding the resolver pty, which only the finalize's worktree cleanup tears
// down). awaitResolverWaiter registers the waiter entry synchronously, so
// releasing the lock immediately after it can never miss a signal that races
// in. (The mid-merge re-spawn path parks lock-free for the same reason.)
//
// awaitResolverWaiter also gives the otherwise-untimed wait a liveness backstop:
// it returns 'resolver-dead' / 'timeout' (instead of blocking forever) if the
// resolver pty dies with no callback, so the caller can recover and the run
// still releases the project lock. `worktreePath` is the resolver's cwd, used
// for that pty-liveness probe.
export function parkOnConflictResolver(
  state: RunState,
  runId: string,
  lock: MergeLockToken,
  worktreePath: string | undefined,
  sessionId?: string,
): Promise<WaiterReleaseReason> {
  const waitForResolver = awaitResolverWaiter(
    state,
    runId,
    lock.taskId,
    worktreePath,
    undefined,
    undefined,
    undefined,
    sessionId,
  );
  release(lock);
  return waitForResolver;
}
