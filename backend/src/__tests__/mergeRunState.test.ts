import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { ConflictWaiterRegistry } from '../mergeRuns/conflictWaiters.js';
import { normalizeLoadedRuns } from '../mergeRuns/normalization.js';
import { snapshotRun } from '../mergeRuns/snapshot.js';
import type { MergeRun } from '../mergeRuns/types.js';

const fallbackProject = path.join(process.cwd(), 'merge-run-state-test-project');

// Let any already-resolved promise's `.then` callbacks run. A pending waiter
// stays pending across this, so a `false` resolved-flag afterwards is proof the
// waiter was NOT released (rather than just not-yet-observed).
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

test('normalizeLoadedRuns marks interrupted running runs errored', () => {
  const before = Date.now();
  const [run] = normalizeLoadedRuns(
    [
      {
        id: 'run_interrupted',
        projectPath: fallbackProject,
        status: 'running',
        startedAt: 10,
        current: 'task_in_progress',
      },
    ],
    fallbackProject,
  );
  const after = Date.now();

  assert.equal(run.status, 'errored');
  assert.equal(run.current, undefined);
  assert.equal(run.cancelRequested, true);
  assert.ok(run.finishedAt !== undefined);
  assert.ok(run.finishedAt >= before && run.finishedAt <= after);
  assert.deepEqual(run.errored, [
    {
      taskId: '(run)',
      error: 'merge run was interrupted by backend restart',
    },
  ]);
});

test('normalizeLoadedRuns filters persisted arrays to expected entry shapes', () => {
  const [run] = normalizeLoadedRuns(
    [
      {
        id: 'run_arrays',
        projectPath: fallbackProject,
        status: 'completed',
        startedAt: 20,
        total: 'not-a-number',
        processed: 'not-a-number',
        merged: ['merged-a', 123, 'merged-b', null],
        conflicted: [false, 'conflicted-a', {}, 'conflicted-b'],
        errored: [
          { taskId: 'task-a', error: 'boom' },
          { taskId: 7, error: 'bad task id' },
          { taskId: 'task-b', error: 'still valid', extra: true },
          null,
        ],
      },
    ],
    fallbackProject,
  );

  assert.equal(run.total, 0);
  assert.equal(run.processed, 0);
  assert.deepEqual(run.merged, ['merged-a', 'merged-b']);
  assert.deepEqual(run.conflicted, ['conflicted-a', 'conflicted-b']);
  assert.deepEqual(run.errored, [
    { taskId: 'task-a', error: 'boom' },
    { taskId: 'task-b', error: 'still valid', extra: true },
  ]);
});

test('normalizeLoadedRuns preserves cancelRequested when present and defaults it from status repair', () => {
  const runs = normalizeLoadedRuns(
    [
      { id: 'completed', status: 'completed', startedAt: 1 },
      { id: 'cancelled', status: 'cancelled', startedAt: 1 },
      { id: 'errored', status: 'errored', startedAt: 1 },
      { id: 'requested', status: 'completed', startedAt: 1, cancelRequested: true },
      { id: 'unknown_status', status: 'unknown', startedAt: 1 },
    ],
    fallbackProject,
  );
  const byId = new Map(runs.map((run) => [run.id, run]));

  assert.equal(byId.get('completed')?.cancelRequested, false);
  assert.equal(byId.get('cancelled')?.cancelRequested, false);
  assert.equal(byId.get('errored')?.cancelRequested, false);
  assert.equal(byId.get('requested')?.cancelRequested, true);
  assert.equal(byId.get('unknown_status')?.status, 'errored');
  assert.equal(byId.get('unknown_status')?.cancelRequested, true);
});

test('normalizeLoadedRuns rejects foreign project records and canonicalizes the owning project', () => {
  const candidateProject = path.join(process.cwd(), 'merge-run-state-candidate');
  const fallback = path.join(process.cwd(), 'merge-run-state-fallback');
  const runs = normalizeLoadedRuns(
    [
      {
        id: 'candidate_path',
        projectPath: candidateProject,
        status: 'completed',
        startedAt: 1,
      },
      { id: 'fallback_path', status: 'completed', startedAt: 1 },
    ],
    fallback,
  );

  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'fallback_path');
  assert.equal(runs[0].projectPath, canonicalProjectPath(fallback));
});

test('snapshotRun clones mutable arrays and error entries', () => {
  const run: MergeRun = {
    id: 'run_snapshot',
    projectPath: fallbackProject,
    status: 'running',
    startedAt: 1,
    total: 2,
    processed: 1,
    current: 'task-current',
    merged: ['task-merged'],
    conflicted: ['task-conflicted'],
    errored: [{ taskId: 'task-error', error: 'boom' }],
    cancelRequested: false,
  };

  const snap = snapshotRun(run);

  assert.deepEqual(snap, run);
  assert.notEqual(snap.merged, run.merged);
  assert.notEqual(snap.conflicted, run.conflicted);
  assert.notEqual(snap.errored, run.errored);
  assert.notEqual(snap.errored[0], run.errored[0]);

  snap.merged.push('later-merged');
  snap.conflicted.push('later-conflicted');
  snap.errored[0].error = 'changed';

  assert.deepEqual(run.merged, ['task-merged']);
  assert.deepEqual(run.conflicted, ['task-conflicted']);
  assert.deepEqual(run.errored, [{ taskId: 'task-error', error: 'boom' }]);
});

test('ConflictWaiterRegistry signals by task id and cancellation unblocks by run id', async () => {
  const waiters = new ConflictWaiterRegistry();
  let signalled = false;
  const signalPromise = waiters
    .register('run-a', 'task-a')
    .then(() => {
      signalled = true;
    });

  assert.equal(waiters.signal('task-b'), false);
  assert.equal(signalled, false);
  assert.equal(waiters.signal('task-a'), true);
  await signalPromise;
  assert.equal(signalled, true);
  assert.equal(waiters.signal('task-a'), false);

  let cancelled = false;
  const cancelPromise = waiters
    .register('run-b', 'task-b')
    .then(() => {
      cancelled = true;
    });

  assert.equal(waiters.unblockRun('run-c'), false);
  assert.equal(cancelled, false);
  assert.equal(waiters.unblockRun('run-b'), true);
  await cancelPromise;
  assert.equal(cancelled, true);
});

test('ConflictWaiterRegistry.abandon ignores a runId mismatch and leaves the waiter parked', async () => {
  const waiters = new ConflictWaiterRegistry();
  let released = false;
  const waiter = waiters.register('run-a', 'task-a').then(() => {
    released = true;
  });

  // A liveness backstop from some other run must not drop this run's waiter.
  assert.equal(waiters.abandon('task-a', 'run-other'), false);
  await flushMicrotasks();
  assert.equal(released, false);

  // Unknown taskId is also a no-op, and neither miss consumed the entry: the
  // owning run's abandon still finds it.
  assert.equal(waiters.abandon('task-missing', 'run-a'), false);
  assert.equal(waiters.abandon('task-a', 'run-a'), true);
  await waiter;
  assert.equal(released, true);

  // The entry is gone, so a second abandon (a stray late backstop) finds nothing.
  assert.equal(waiters.abandon('task-a', 'run-a'), false);
});

test('ConflictWaiterRegistry.abandon from a prior run does not release a re-queued task\'s fresh waiter', async () => {
  const waiters = new ConflictWaiterRegistry();

  // Run A parks on task-a, its resolver really completes, waiter is consumed.
  let releasedA = false;
  const waiterA = waiters.register('run-a', 'task-a').then(() => {
    releasedA = true;
  });
  assert.equal(waiters.signal('task-a'), true);
  await waiterA;
  assert.equal(releasedA, true);

  // The task gets re-queued and run B parks on it under the SAME taskId.
  let releasedB = false;
  const waiterB = waiters.register('run-b', 'task-a').then(() => {
    releasedB = true;
  });

  // Run A's stale liveness backstop fires late. It must not advance run B past
  // its still-working resolver.
  assert.equal(waiters.abandon('task-a', 'run-a'), false);
  await flushMicrotasks();
  assert.equal(releasedB, false);

  // Run B's own release still works.
  assert.equal(waiters.abandon('task-a', 'run-b'), true);
  await waiterB;
  assert.equal(releasedB, true);
});
