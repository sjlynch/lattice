import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parkOnConflictResolver } from '../mergeRuns/resolverSpawn.js';
import { createRunState, signalConflictWaiterInState } from '../mergeRuns/state.js';
import { tryAcquire, release, isLocked } from '../mergeLocks.js';

// Regression: the merge-run worker used to park on the conflict waiter while
// STILL holding the per-task merge lock (acquired in processTarget /
// tryFinalizeAfterResolverFinished for the in-worktree git merge). The
// resolver's Stop hook -> /complete -> finalizeResolvedTask takes that SAME
// lock to re-sync, FF main, and signal the waiter; holding it across the wait
// made /complete lose tryAcquire, return 'already-finalizing' WITHOUT
// signalling, and the worker parked forever — the whole "Merge All" run stuck,
// and the resolver pty never torn down (only finalize's worktree cleanup kills
// it), so the resolver session never closed.
//
// parkOnConflictResolver must drop the lock before waiting (registering the
// waiter first, synchronously, so a racing signal can't be missed) and the
// worker must not later release a lock it no longer owns.

async function nextTick(): Promise<void> {
  await Promise.resolve();
}

test('parkOnConflictResolver releases the per-task merge lock before waiting', async () => {
  const state = createRunState();
  const taskId = `t_park_release_${Date.now()}`;

  // The worker holds the lock through the git merge that produced the conflict.
  const workerLock = tryAcquire(taskId);
  assert.notEqual(workerLock, null);

  let resumed = false;
  const parked = parkOnConflictResolver(state, 'run-park', workerLock!).then(() => {
    resumed = true;
  });
  // registerConflictWaiter + release run synchronously before the await, so the
  // lock is already free here — but tick once for good measure.
  await nextTick();

  // The lock MUST be free now so the resolver's /complete finalize can take it.
  assert.equal(isLocked(taskId), false, 'lock must be released before parking');
  assert.equal(resumed, false, 'worker must still be parked until signalled');

  // Mirror production ordering in finalizeResolvedTask: the finalizer acquires
  // the lock, performs the git work, signals the waiter while it still owns the
  // lock, then releases in its finally. A second caller must not be able to
  // acquire until that finalizer release happens.
  const finalizerLock = tryAcquire(taskId);
  assert.notEqual(finalizerLock, null, 'finalizer can acquire the freed lock');
  assert.equal(signalConflictWaiterInState(state, taskId), true);
  assert.equal(
    tryAcquire(taskId),
    null,
    'no second acquire is possible until the finalizer releases',
  );
  assert.equal(
    release(workerLock!),
    false,
    'a stale worker token must not clear the finalizer-owned lock',
  );
  assert.equal(isLocked(taskId), true);
  release(finalizerLock!);

  await parked;
  assert.equal(resumed, true, 'signalled worker resumes');
  assert.equal(isLocked(taskId), false);
});

test('parkOnConflictResolver still resumes when /complete signals before the await settles', async () => {
  // The waiter entry is recorded synchronously inside registerConflictWaiter,
  // so a signal arriving the instant the lock frees is never lost.
  const state = createRunState();
  const taskId = `t_park_race_${Date.now()}`;

  const workerLock = tryAcquire(taskId);
  assert.notEqual(workerLock, null);
  const parked = parkOnConflictResolver(state, 'run-race', workerLock!);
  // Signal immediately — before yielding back to the parked await.
  assert.equal(isLocked(taskId), false);
  assert.equal(signalConflictWaiterInState(state, taskId), true);

  await parked; // resolves; would hang forever if the signal had been missed
});
