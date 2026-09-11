import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeMergeRun } from '../mergeRuns/finalize.js';
import { autoRestartIfNeeded } from '../mergeRuns/teardown.js';
import type { Task } from '../tasks.js';
import type { MergeRun } from '../mergeRuns/state.js';
import { loadRunTargets } from '../mergeRuns/lifecycle.js';

function makeRun(over: Partial<MergeRun> = {}): MergeRun {
  return {
    id: 'run_test',
    projectPath: '/project',
    status: 'running',
    startedAt: 1,
    total: 0,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: [],
    cancelRequested: false,
    ...over,
  };
}

test('merge startup releases its lock when tasks cannot be read before the worker exists', async () => {
  let released = false;
  await assert.rejects(loadRunTargets('/project', {
    release: async () => { released = true; },
  }, async () => { throw new Error('task storage unavailable'); }), /task storage unavailable/);
  assert.equal(released, true);
});

// Only id/status/conflict are read by the filter; cast a partial as Task.
function makeTask(over: Partial<Task>): Task {
  return { id: 'task', status: 'ready_to_merge', ...over } as unknown as Task;
}

// --- finalizeMergeRun ordering invariant (the core of the bug) -----------------

test('finalizeMergeRun restarts only after the lock release resolves', async () => {
  const order: string[] = [];
  let released = false;

  await finalizeMergeRun({
    body: async () => true, // teardown decided a fresh run is needed
    onError: () => assert.fail('onError should not be called on a clean run'),
    releaseLock: async () => {
      // Resolve on a later turn so a restart fired before release would be
      // observable as out-of-order.
      await new Promise((resolve) => setImmediate(resolve));
      released = true;
      order.push('release');
    },
    restart: () => {
      assert.equal(released, true, 'restart must run after the lock is released');
      order.push('restart');
    },
  });

  assert.deepEqual(order, ['release', 'restart']);
});

test('finalizeMergeRun does not restart when no task became ready mid-run', async () => {
  let released = false;
  let restarted = false;

  await finalizeMergeRun({
    body: async () => false,
    onError: () => assert.fail('onError should not be called on a clean run'),
    releaseLock: async () => {
      released = true;
    },
    restart: () => {
      restarted = true;
    },
  });

  assert.equal(released, true);
  assert.equal(restarted, false);
});

test('finalizeMergeRun releases the lock and suppresses restart when the worker crashes', async () => {
  const boom = new Error('worker crashed');
  let caught: unknown;
  let released = false;
  let restarted = false;

  await finalizeMergeRun({
    body: async () => {
      throw boom;
    },
    onError: (err) => {
      caught = err;
    },
    releaseLock: async () => {
      released = true;
    },
    restart: () => {
      restarted = true;
    },
  });

  assert.equal(caught, boom);
  assert.equal(released, true, 'lock must be released even on a crash');
  assert.equal(restarted, false, 'a crashed worker must not auto-restart');
});

// --- autoRestartIfNeeded decision (stubbed listTasks) --------------------------

test('autoRestartIfNeeded returns true for a ready task that was not a target', async () => {
  const targets = [makeTask({ id: 'a' })];
  const listTasksFn = async () => [
    makeTask({ id: 'a' }), // already merged this run
    makeTask({ id: 'b' }), // became ready mid-run — not in targets
  ];

  const result = await autoRestartIfNeeded(
    '/project',
    makeRun(),
    targets,
    'acquire',
    listTasksFn,
  );

  assert.equal(result, true);
});

test('autoRestartIfNeeded returns false when every ready task was already a target', async () => {
  const targets = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
  const listTasksFn = async () => [makeTask({ id: 'a' }), makeTask({ id: 'b' })];

  const result = await autoRestartIfNeeded(
    '/project',
    makeRun(),
    targets,
    'acquire',
    listTasksFn,
  );

  assert.equal(result, false);
});

test('autoRestartIfNeeded ignores conflict-flagged ready tasks', async () => {
  const listTasksFn = async () => [
    makeTask({ id: 'b', conflict: true }),
  ];

  const result = await autoRestartIfNeeded('/project', makeRun(), [], 'acquire', listTasksFn);

  assert.equal(result, false);
});

test('autoRestartIfNeeded returns false for a cancelled run', async () => {
  const listTasksFn = async () => [makeTask({ id: 'b' })];

  const result = await autoRestartIfNeeded(
    '/project',
    makeRun({ cancelRequested: true }),
    [],
    'acquire',
    listTasksFn,
  );

  assert.equal(result, false);
});

test('autoRestartIfNeeded returns false when the lock was inherited', async () => {
  const listTasksFn = async () => [makeTask({ id: 'b' })];

  const result = await autoRestartIfNeeded('/project', makeRun(), [], 'inherit', listTasksFn);

  assert.equal(result, false);
});

test('autoRestartIfNeeded swallows a listTasks failure and returns false', async () => {
  const listTasksFn = async () => {
    throw new Error('disk read failed');
  };

  const result = await autoRestartIfNeeded('/project', makeRun(), [], 'acquire', listTasksFn);

  assert.equal(result, false);
});
