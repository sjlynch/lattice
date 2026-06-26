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
// waiter first, synchronously, so a racing signal can't be missed).

async function nextTick(): Promise<void> {
  await Promise.resolve();
}

test('parkOnConflictResolver releases the per-task merge lock before waiting', async () => {
  const state = createRunState();
  const taskId = `t_park_release_${Date.now()}`;

  // The worker holds the lock through the git merge that produced the conflict.
  assert.equal(tryAcquire(taskId), true);

  let resumed = false;
  const parked = parkOnConflictResolver(state, 'run-park', taskId).then(() => {
    resumed = true;
  });
  // registerConflictWaiter + release run synchronously before the await, so the
  // lock is already free here — but tick once for good measure.
  await nextTick();

  // The lock MUST be free now so the resolver's /complete finalize can take it.
  assert.equal(isLocked(taskId), false, 'lock must be released before parking');
  assert.equal(resumed, false, 'worker must still be parked until signalled');

  // Mirror the resolver finalize: it can acquire the lock (it could not before
  // the fix), then signals the same task id, which resumes the worker.
  assert.equal(tryAcquire(taskId), true, 'finalizer can acquire the freed lock');
  release(taskId);
  assert.equal(signalConflictWaiterInState(state, taskId), true);

  await parked;
  assert.equal(resumed, true, 'signalled worker resumes');
});

test('parkOnConflictResolver still resumes when /complete signals before the await settles', async () => {
  // The waiter entry is recorded synchronously inside registerConflictWaiter,
  // so a signal arriving the instant the lock frees is never lost.
  const state = createRunState();
  const taskId = `t_park_race_${Date.now()}`;

  assert.equal(tryAcquire(taskId), true);
  const parked = parkOnConflictResolver(state, 'run-race', taskId);
  // Signal immediately — before yielding back to the parked await.
  assert.equal(isLocked(taskId), false);
  assert.equal(signalConflictWaiterInState(state, taskId), true);

  await parked; // resolves; would hang forever if the signal had been missed
});
