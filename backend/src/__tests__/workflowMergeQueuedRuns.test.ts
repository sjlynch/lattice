import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runMergeStep, type MergeStepDeps } from '../workflowRuns/controlSteps/merge.js';
import { waitForMergeWork, type MergeWorkWaitDeps } from '../workflowRuns/controlSteps/shared.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import { subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { Task } from '../tasks.js';
import type { Workflow } from '../workflows.js';
import type { MergeRun } from '../mergeRuns/state.js';

// Start can admit runs while their tasks stay Open (capacity, disk, checkout).
// Merge used to see an empty In Progress lane and advance before they spawned,
// or forget running tasks arriving during a merge round. Exercise the real
// combined waiter and control-step lock lifecycle without stores, git or ptys.
const PROJECT = '/project';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function task(id: string, status: Task['status'] = 'open', runQueued = false): Task {
  return { id, title: id, projectPath: PROJECT, createdAt: 1, status, runQueued } as Task;
}

function fixture(t: TestContext, tasks: Task[]) {
  const run: WorkflowRun = {
    id: 'wfrun_queued', workflowId: 'wf', workflowName: 'wf', projectPath: PROJECT,
    status: 'running', startedAt: 1, totalSteps: 1, currentStepIndex: 0,
  };
  const wf = { projectPath: PROJECT, steps: [{ kind: 'merge' }] } as Workflow;
  const taskListeners = new Set<Parameters<MergeWorkWaitDeps['subscribeTasks']>[0]>();
  const runListeners = new Set<(ev: WorkflowRunEvent) => void>();
  const live = new Set<string>();
  const rounds: string[][] = [];
  const messages: string[] = [];
  const innerRuns = new Map<string, MergeRun>();
  let advanced = false;
  let released = 0;
  let hookCalls = 0;
  let done: Promise<void> | undefined;
  let settled = false;
  const snapshot = () => tasks.map((task) => ({ ...task }));
  const publish = () => {
    for (const listener of taskListeners) listener(PROJECT, snapshot());
  };
  const cancel = () => {
    run.status = 'cancelled';
    for (const listener of runListeners) listener({ type: 'cancelled', run });
  };
  const waitDeps: MergeWorkWaitDeps = {
    listTasks: async () => snapshot(),
    subscribeTasks: (cb) => { taskListeners.add(cb); return () => { taskListeners.delete(cb); }; },
    subscribeRun: (cb) => { runListeners.add(cb); return () => { runListeners.delete(cb); }; },
    hasQueuedRun: (id) => live.has(id),
  };
  const deps: MergeStepDeps = {
    listTasks: waitDeps.listTasks,
    waitForMergeWork: (project, run, progress) => waitForMergeWork(project, run, progress, 1000, waitDeps),
    subscribeWorkflowRuns: waitDeps.subscribeRun,
    startMergeRun: async (_project, _origin, options) => {
      assert.equal(options?.lockMode, 'inherit');
      const ready = tasks.filter((task) => task.status === 'ready_to_merge');
      rounds.push(ready.map((task) => task.id));
      for (const task of ready) task.status = 'qa';
      publish();
      const inner: MergeRun = {
        id: `mr_${rounds.length}`, projectPath: PROJECT, status: 'completed', startedAt: 1,
        total: ready.length, processed: ready.length, merged: ready.map((task) => task.id),
        conflicted: [], errored: [], cancelRequested: false,
      };
      innerRuns.set(inner.id, inner);
      return inner;
    },
    getMergeRun: (id) => innerRuns.get(id) ?? null,
    cancelMergeRun: () => false,
    subscribeMergeRuns: () => () => undefined,
    waitForPostMergeHookIdle: async () => { hookCalls += 1; },
  };
  const unsubscribe = subscribe((ev) => {
    if (ev.type === 'step-control-progress' && ev.runId === run.id) messages.push(ev.message ?? '');
  });
  t.after(async () => {
    if (done && !settled) cancel();
    await done;
    unsubscribe();
  });
  return {
    run, tasks, deps, waitDeps, live, rounds, messages, publish, cancel,
    update(id: string, patch: Partial<Task>) {
      Object.assign(tasks.find((task) => task.id === id)!, patch);
      publish();
    },
    start() {
      done = runControlStepWorker(wf, run, 0, 'http://unused', async () => {
        assert.equal(released, 1, 'release the inherited lock before advancing');
        advanced = true;
      }, {
        acquireLock: async () => ({ release: async () => { released += 1; } }),
        waitForRepoMaintenance: async () => true,
        runStart: async () => undefined,
        runMerge: () => runMergeStep(wf, run, 0, 'http://unused', deps),
        runPush: async () => undefined,
      }).finally(() => { settled = true; });
      return done;
    },
    advanced: () => advanced,
    released: () => released,
    hookCalls: () => hookCalls,
    listeners: () => taskListeners.size + runListeners.size,
  };
}

test('an all-queued Open batch drains through running, ready and QA before advancement', async (t) => {
  const f = fixture(t, [task('a', 'open', true), task('b', 'open', true)]);
  const done = f.start();
  await flush();
  assert.equal(f.advanced(), false);
  assert.deepEqual(f.rounds, []);
  f.update('a', { status: 'in_progress', runQueued: false });
  await flush();
  assert.equal(f.advanced(), false);
  f.update('a', { status: 'ready_to_merge' });
  await flush();
  assert.deepEqual(f.rounds, [['a']]);
  assert.equal(f.advanced(), false, 'an empty In Progress gap must still wait for b');
  assert.equal(f.hookCalls(), 0, 'the final hook gate follows the whole drain');
  f.update('b', { status: 'in_progress', runQueued: false });
  await flush();
  assert.equal(f.advanced(), false);
  f.update('b', { status: 'ready_to_merge' });
  await done;
  assert.deepEqual(f.rounds, [['a'], ['b']]);
  assert.ok(f.tasks.every((task) => task.status === 'qa'));
  assert.equal(f.advanced(), true);
  assert.equal(f.hookCalls(), 1);
  assert.equal(f.listeners(), 0);
  assert.equal(f.messages.at(-1), 'merge complete');
});

test('Merge re-checks running tasks that spawn during a merge round', async (t) => {
  const f = fixture(t, [task('a', 'ready_to_merge'), task('b', 'open', true)]);
  const merge = f.deps.startMergeRun;
  f.deps.startMergeRun = async (...args) => {
    f.update('b', { status: 'in_progress', runQueued: false });
    return merge(...args);
  };
  const done = f.start();
  await flush();
  assert.deepEqual(f.rounds, [['a']]);
  assert.equal(f.advanced(), false);
  f.deps.startMergeRun = merge;
  f.update('b', { status: 'ready_to_merge' });
  await done;
  assert.deepEqual(f.rounds, [['a'], ['b']]);
  assert.equal(f.advanced(), true);
});

test('ready work frees disk for queued starts even while other tasks are running', async (t) => {
  const f = fixture(t, [task('ready', 'ready_to_merge'), task('disk', 'open', true), task('running', 'in_progress')]);
  f.update('disk', { runWaitingForDisk: 'waiting for a worktree to be removed' });
  const merge = f.deps.startMergeRun;
  f.deps.startMergeRun = async (...args) => {
    const result = await merge(...args);
    // Simulate notifyDiskSpaceFreed: the deferred task can start only once the
    // first ready worktree has actually merged and been reclaimed.
    f.update('disk', { status: 'in_progress', runQueued: false, runWaitingForDisk: undefined });
    return result;
  };
  const done = f.start();
  await flush();
  assert.deepEqual(f.rounds, [['ready']]);
  assert.equal(f.tasks.find((task) => task.id === 'disk')?.status, 'in_progress');
  assert.equal(f.advanced(), false);
  f.deps.startMergeRun = merge;
  f.update('disk', { status: 'ready_to_merge' });
  f.update('running', { status: 'ready_to_merge' });
  await done;
  assert.deepEqual(f.rounds, [['ready'], ['disk', 'running']]);
  assert.equal(f.advanced(), true);
});

test('ordinary Open/Backlog tasks and failed admissions do not block Merge', async (t) => {
  const f = fixture(t, [task('open'), task('backlog', 'backlog'), task('enqueue-failed')]);
  await f.start();
  assert.equal(f.advanced(), true);
  assert.deepEqual(f.rounds, []);
});

test('a live checkout request blocks even without a runQueued flag', async (t) => {
  const f = fixture(t, [task('checkout')]);
  f.live.add('checkout');
  const done = f.start();
  await flush();
  assert.equal(f.advanced(), false);
  f.live.delete('checkout');
  f.update('checkout', { status: 'in_progress' });
  await flush();
  assert.equal(f.advanced(), false);
  f.update('checkout', { status: 'ready_to_merge' });
  await done;
  assert.deepEqual(f.rounds, [['checkout']]);
});

test('a failed queued spawn clears its flag before queue settlement; polling notices settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, [task('failed', 'open', true)]);
  f.live.add('failed');
  const done = f.start();
  await flush();
  f.update('failed', { runQueued: false });
  assert.equal(f.advanced(), false, 'the request is still in flight during failure cleanup');
  f.live.delete('failed'); // No task-store notification follows queue settlement.
  t.mock.timers.tick(1000);
  await done;
  assert.equal(f.advanced(), true);
  assert.deepEqual(f.rounds, []);
  assert.equal(f.listeners(), 0);
});

test('work admitted during the post-merge hook is drained and gated again', async (t) => {
  const f = fixture(t, [task('a', 'ready_to_merge'), task('b')]);
  const gate = f.deps.waitForPostMergeHookIdle;
  let calls = 0;
  f.deps.waitForPostMergeHookIdle = async (...args) => {
    await gate(...args);
    if (++calls === 1) f.update('b', { runQueued: true });
  };
  const done = f.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.advanced(), false);
  f.update('b', { status: 'in_progress', runQueued: false });
  f.update('b', { status: 'ready_to_merge' });
  await done;
  assert.deepEqual(f.rounds, [['a'], ['b']]);
  assert.equal(calls, 2, 'the hook gate must run after the actual final merge');
});

test('the final task re-check repeats the hook gate after an outside resolver settles', async (t) => {
  const f = fixture(t, [task('resolved')]);
  const gate = f.deps.waitForPostMergeHookIdle;
  let calls = 0;
  f.deps.waitForPostMergeHookIdle = async (...args) => {
    await gate(...args);
    if (++calls === 1) f.update('resolved', { status: 'in_progress' });
  };
  const done = f.start();
  await flush();
  assert.equal(f.advanced(), false);
  f.update('resolved', { status: 'qa' });
  await done;
  assert.equal(calls, 2, 'outside finalization may have fired another hook');
  assert.equal(f.advanced(), true);
});

test('cancelling a queued drain releases the lock and subscriptions without advancing', async (t) => {
  const f = fixture(t, [task('queued', 'open', true)]);
  const done = f.start();
  await flush();
  f.cancel();
  await done;
  assert.equal(f.run.status, 'cancelled');
  assert.equal(f.released(), 1);
  assert.equal(f.listeners(), 0);
  assert.equal(f.advanced(), false);
  assert.ok(!f.messages.includes('merge complete'));
});

test('a queued no-progress timeout releases the lock and errors without advancing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, [task('queued', 'open', true)]);
  const done = f.start();
  await flush();
  t.mock.timers.tick(800);
  f.update('queued', { title: 'metadata is not progress' });
  t.mock.timers.tick(200);
  await done;
  assert.equal(f.run.status, 'errored');
  assert.match(f.run.error ?? '', /queued\/In Progress tasks made no progress for 1000ms/);
  assert.equal(f.released(), 1);
  assert.equal(f.listeners(), 0);
  assert.equal(f.advanced(), false);
});

test('queued -> running progress re-arms the timeout without changing the task count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, [task('queued', 'open', true)]);
  const done = f.start();
  await flush();
  t.mock.timers.tick(800);
  f.update('queued', { status: 'in_progress', runQueued: false });
  t.mock.timers.tick(800);
  f.update('queued', { status: 'ready_to_merge' });
  await done;
  assert.equal(f.advanced(), true, 'productive work can exceed the total timeout duration');
  assert.deepEqual(f.rounds, [['queued']]);
});

test('task-store read failures during a queued drain release its lock and subscriptions', async (t) => {
  const f = fixture(t, []);
  f.waitDeps.listTasks = async () => { throw new Error('task store read failed'); };
  await f.start();
  assert.equal(f.run.status, 'errored');
  assert.match(f.run.error ?? '', /task store read failed/);
  assert.equal(f.released(), 1);
  assert.equal(f.listeners(), 0);
  assert.equal(f.advanced(), false);
});

test('a hung initial task read is bounded during the combined drain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, []);
  f.waitDeps.listTasks = () => new Promise(() => {});
  const done = f.start();
  await flush();
  t.mock.timers.tick(1000);
  await done;
  assert.equal(f.run.status, 'errored');
  assert.equal(f.released(), 1);
  assert.equal(f.listeners(), 0);
  assert.equal(f.advanced(), false);
});

test('a task notification during the initial read cannot be overwritten by a stale empty snapshot', async (t) => {
  const f = fixture(t, [task('queued', 'open', true)]);
  let finishRead!: (tasks: Task[]) => void;
  const read = f.waitDeps.listTasks;
  f.waitDeps.listTasks = () => new Promise((resolve) => { finishRead = resolve; });
  const done = f.start();
  await flush();
  f.publish();
  finishRead([]);
  await flush();
  assert.equal(f.advanced(), false);
  f.waitDeps.listTasks = read;
  f.update('queued', { status: 'in_progress', runQueued: false });
  f.update('queued', { status: 'ready_to_merge' });
  await done;
  assert.equal(f.advanced(), true);
});

test('progress callback failures reject a queued waiter and release its subscriptions', async (t) => {
  const f = fixture(t, [task('queued', 'open', true)]);
  let reports = 0;
  const waiting = waitForMergeWork(PROJECT, f.run, () => {
    if (++reports > 1) throw new Error('progress callback failed');
  }, 1000, f.waitDeps);
  const rejected = assert.rejects(waiting, /progress callback failed/);
  await flush();
  f.publish();
  await rejected;
  assert.equal(f.listeners(), 0);
});

test('a synchronous cancellation during subscription cleans up both listeners', async (t) => {
  const f = fixture(t, [task('queued', 'open', true)]);
  const subscribeRun = f.waitDeps.subscribeRun;
  f.waitDeps.subscribeRun = (cb) => {
    const unsubscribe = subscribeRun(cb);
    f.cancel();
    return unsubscribe;
  };
  await waitForMergeWork(PROJECT, f.run, () => {}, 1000, f.waitDeps);
  assert.equal(f.listeners(), 0);
});
