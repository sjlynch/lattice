// A Start step used to admit tasks after cancellation during its admission
// poll, and its pending direct starts had no cancellation signal. Deferred
// promises exercise those windows without terminals, git or timing guesses.
// Real startTaskById checkpoints also prove withdrawal reclaims only its own
// checkout/PTY and leaves established tasks and independent starts alone.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createTask, deleteTask, getTask, type Task } from '../tasks.js';
import { cancelWorkflowRun } from '../workflowRuns.js';
import { notify, runs, subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import { runStartStep, type StartStepDeps } from '../workflowRuns/controlSteps/start.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import { startTaskById, type StartTaskDeps, type StartTaskByIdResult } from '../routes/tasks/startTask.js';
import { SpawnCapacityError, SpawnDiskSpaceError } from '../spawnQueue.js';
import type { Workflow } from '../workflows.js';

const ORIGIN = 'http://127.0.0.1:1';
let fixtureIndex = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext) {
  const id = `start-cancel-${process.pid}-${++fixtureIndex}`;
  const projectPath = path.join(os.tmpdir(), id);
  const run: WorkflowRun = {
    id, workflowId: 'wf', workflowName: 'wf', projectPath,
    status: 'running', startedAt: 1, totalSteps: 1, currentStepIndex: 0,
    harnessOverride: 'claude',
  };
  const wf = { projectPath, steps: [{ kind: 'start' }] } as Workflow;
  const task: Task = { id: `${id}-task`, projectPath, title: 'task', status: 'open', createdAt: 1 };
  runs.set(id, run);
  t.after(() => { runs.delete(id); });
  const events: WorkflowRunEvent[] = [];
  t.after(subscribe((ev) => {
    if (('runId' in ev && ev.runId === id) || ('run' in ev && ev.run.id === id)) events.push(ev);
  }));
  const subscriptions = { active: 0, removed: 0 };
  const subscribeRun: typeof subscribe = (cb) => {
    subscriptions.active++;
    const unsub = subscribe(cb);
    return () => { subscriptions.active--; subscriptions.removed++; unsub(); };
  };
  const calls = { starts: 0, enqueues: 0 };
  const deps: StartStepDeps = {
    listTasks: async () => [task],
    admissionHold: async () => null,
    startTask: async () => { calls.starts++; return spawned(task); },
    enqueueRun: async () => { calls.enqueues++; return { queued: true }; },
    subscribeRun,
  };
  const execute = () => runStartStep(wf, run, 0, ORIGIN, deps);
  return { run, wf, task, events, subscriptions, calls, deps, execute };
}

function spawned(task: Task): StartTaskByIdResult {
  const worktreePath = path.join(os.tmpdir(), 'start-cancel-checkout', task.id);
  return {
    task: { ...task, status: 'in_progress' }, worktreePath,
    branch: `lattice/${task.id}`, taskFile: path.join(worktreePath, 'LATTICE_TASK.md'),
    command: 'claude', serverId: `pty-${task.id}`,
  };
}

function assertNoLateProgress(events: WorkflowRunEvent[], after: number): void {
  assert.equal(events.slice(after).some((ev) =>
    ev.type === 'workflow-task-spawned' || ev.type === 'step-control-progress'), false);
}

for (const hold of [null, 'CPU hold']) {
  test(`cancellation during admission poll prevents ${hold ? 'enqueue' : 'direct start'}`, async (t) => {
    const f = fixture(t);
    const reached = deferred<void>();
    const admission = deferred<string | null>();
    f.deps.admissionHold = () => { reached.resolve(); return admission.promise; };
    const work = f.execute();
    await reached.promise;
    assert.equal(cancelWorkflowRun(f.run.id), true);
    const after = f.events.length;
    admission.resolve(hold);
    await work;
    assert.deepEqual(f.calls, { starts: 0, enqueues: 0 });
    assert.equal(f.run.status, 'cancelled');
    assertNoLateProgress(f.events, after);
  });
}

for (const end of ['errored', 'completed', 'next-step'] as const) {
  test(`a ${end} workflow cannot admit work after its pending poll`, async (t) => {
    const f = fixture(t);
    const reached = deferred<void>();
    const admission = deferred<string | null>();
    f.deps.admissionHold = () => { reached.resolve(); return admission.promise; };
    const work = f.execute();
    await reached.promise;
    if (end === 'next-step') f.run.currentStepIndex++;
    else f.run.status = end;
    admission.resolve('agent cap');
    const after = f.events.length;
    await work;
    assert.deepEqual(f.calls, { starts: 0, enqueues: 0 });
    assertNoLateProgress(f.events, after);
  });
}

test('cancellation during the initial task read produces no admission or progress', async (t) => {
  const f = fixture(t);
  const tasks = deferred<Task[]>();
  f.deps.listTasks = () => tasks.promise;
  const work = f.execute();
  cancelWorkflowRun(f.run.id);
  const after = f.events.length;
  tasks.resolve([f.task]);
  await work;
  assert.deepEqual(f.calls, { starts: 0, enqueues: 0 });
  assertNoLateProgress(f.events, after);
});

for (const result of ['capacity', 'disk', 'failure', 'success'] as const) {
  test(`a late direct-start ${result} preserves cancellation without requeue or success`, async (t) => {
    const f = fixture(t);
    const reached = deferred<AbortSignal>();
    const allocation = deferred<StartTaskByIdResult>();
    f.deps.startTask = (_id, _origin, options) => {
      assert.ok(options?.signal);
      reached.resolve(options.signal);
      return allocation.promise;
    };
    const work = f.execute();
    const signal = await reached.promise;
    assert.equal(f.subscriptions.active, 1);
    cancelWorkflowRun(f.run.id);
    assert.equal(signal.aborted, true, 'the pending direct start owns a workflow cancellation signal');
    const after = f.events.length;
    if (result === 'success') allocation.resolve(spawned(f.task));
    else allocation.reject(result === 'capacity' ? new SpawnCapacityError('hard cap')
      : result === 'disk' ? new SpawnDiskSpaceError('disk reserve', 1000) : new Error('setup failed'));
    await work;
    assert.equal(f.calls.enqueues, 0);
    assert.equal(f.run.status, 'cancelled');
    assert.equal(f.run.error, undefined);
    assert.deepEqual(f.subscriptions, { active: 0, removed: 1 });
    assertNoLateProgress(f.events, after);
  });
}

test('advancing the workflow step withdraws a direct launch still in flight', async (t) => {
  const f = fixture(t);
  const reached = deferred<AbortSignal>();
  const allocation = deferred<StartTaskByIdResult>();
  f.deps.startTask = (_id, _origin, options) => {
    assert.ok(options?.signal);
    reached.resolve(options.signal);
    return allocation.promise;
  };
  const work = f.execute();
  const signal = await reached.promise;
  f.run.currentStepIndex++;
  notify({ type: 'progress', run: f.run });
  assert.equal(signal.aborted, true);
  const after = f.events.length;
  allocation.reject(new SpawnCapacityError('cap'));
  await work;
  assert.equal(f.calls.enqueues, 0);
  assertNoLateProgress(f.events, after);
  assert.equal(f.subscriptions.active, 0);
});

for (const phase of ['setup', 'allocation'] as const) {
  test(`cancelling during real startTaskById ${phase} reclaims its own launch`, async (t) => {
    const f = fixture(t);
    const task = await createTask(f.wf.projectPath, 'withdrawn workflow start');
    t.after(async () => { await deleteTask(task.id); });
    const info = spawned(task);
    const reached = deferred<AbortSignal>();
    const resume = deferred<void>();
    const calls = { allocated: 0, killed: [] as string[], cleaned: [] as string[] };
    let signal!: AbortSignal;
    const pause = async () => { reached.resolve(signal); await resume.promise; };
    const startDeps: StartTaskDeps = {
      setupTaskWorktree: async () => { if (phase === 'setup') await pause(); return info; },
      selectHarnessCommand: () => ({
        harness: 'claude', commandBuilder: () => 'claude',
        createSession: async () => {
          calls.allocated++;
          if (phase === 'allocation') await pause();
          return { command: 'claude', serverId: info.serverId };
        },
      }),
      discard: {
        killSession: async (id) => { calls.killed.push(id); },
        cleanupWorktree: async (_project, cwd) => { calls.cleaned.push(cwd); return true; },
      },
    };
    f.deps.listTasks = async () => [task];
    f.deps.startTask = (id, origin, options) => {
      assert.ok(options?.signal);
      signal = options.signal;
      return startTaskById(id, origin, { ...options, deps: startDeps });
    };
    const work = f.execute();
    await reached.promise;
    cancelWorkflowRun(f.run.id);
    assert.equal(signal.aborted, true);
    const after = f.events.length;
    resume.resolve();
    await work;
    const current = await getTask(task.id);
    assert.equal(current?.status, 'open');
    assert.equal(current?.worktreePath, undefined);
    assert.equal(current?.runQueued, undefined);
    assert.equal(calls.allocated, phase === 'setup' ? 0 : 1);
    assert.deepEqual(calls.killed, phase === 'allocation' ? [info.serverId] : []);
    assert.deepEqual(calls.cleaned, [info.worktreePath]);
    assert.equal(f.calls.enqueues, 0);
    assert.equal(f.subscriptions.active, 0);
    assertNoLateProgress(f.events, after);
  });
}

test('an independently admitted queue request during a direct start is left alone after deferral', async (t) => {
  const f = fixture(t);
  const reached = deferred<void>();
  const allocation = deferred<StartTaskByIdResult>();
  let independentlyQueued = false;
  f.deps.hasQueuedRun = () => independentlyQueued;
  f.deps.startTask = () => { reached.resolve(); return allocation.promise; };
  const work = f.execute();
  await reached.promise;
  independentlyQueued = true;
  f.task.runQueued = true;
  allocation.reject(new SpawnCapacityError('cap'));
  await work;
  cancelWorkflowRun(f.run.id);
  assert.equal(f.calls.enqueues, 0, 'do not replace the other caller\'s queue request');
  assert.equal(f.task.runQueued, true);
  assert.equal(independentlyQueued, true);
});

test('a concurrent independent start survives withdrawal of the workflow launch', async (t) => {
  const f = fixture(t);
  const task = await createTask(f.wf.projectPath, 'independent start');
  t.after(async () => { await deleteTask(task.id); });
  const info = spawned(task);
  const reached = deferred<void>();
  const resume = deferred<void>();
  const independent = new AbortController();
  const calls = { setups: 0, allocated: 0, killed: 0, cleaned: 0 };
  const startDeps: StartTaskDeps = {
    setupTaskWorktree: async () => {
      if (++calls.setups === 1) { reached.resolve(); await resume.promise; }
      return info;
    },
    selectHarnessCommand: () => ({
      harness: 'claude', commandBuilder: () => 'claude',
      createSession: async () => { calls.allocated++; return { command: 'claude', serverId: info.serverId }; },
    }),
    discard: {
      killSession: async () => { calls.killed++; },
      cleanupWorktree: async () => { calls.cleaned++; return true; },
    },
  };
  f.deps.listTasks = async () => [task];
  f.deps.startTask = (id, origin, options) => startTaskById(id, origin, { ...options, deps: startDeps });
  const workflowWork = f.execute();
  await reached.promise;
  const independentWork = startTaskById(task.id, ORIGIN, {
    requestedHarness: 'claude', signal: independent.signal, deps: startDeps,
  });
  cancelWorkflowRun(f.run.id);
  resume.resolve();
  await workflowWork;
  const result = await independentWork;
  assert.equal(independent.signal.aborted, false);
  assert.equal(result.serverId, info.serverId);
  assert.equal((await getTask(task.id))?.status, 'in_progress');
  assert.deepEqual(calls, { setups: 2, allocated: 1, killed: 0, cleaned: 1 });
  assert.equal(f.events.some((ev) => ev.type === 'workflow-task-spawned'), false);
});

test('cancelling during a later admission poll preserves a task the workflow already established', async (t) => {
  const f = fixture(t);
  const task = await createTask(f.wf.projectPath, 'established task');
  t.after(async () => { await deleteTask(task.id); });
  const info = spawned(task);
  const reached = deferred<void>();
  const admission = deferred<string | null>();
  let polls = 0;
  let discarded = 0;
  const signals: AbortSignal[] = [];
  f.deps.listTasks = async () => [task, { ...f.task, createdAt: task.createdAt + 1 }];
  f.deps.admissionHold = () => {
    if (++polls === 1) return Promise.resolve(null);
    reached.resolve();
    return admission.promise;
  };
  f.deps.startTask = (id, origin, options) => {
    assert.ok(options?.signal);
    signals.push(options.signal);
    return startTaskById(id, origin, { ...options, deps: {
      setupTaskWorktree: async () => info,
      selectHarnessCommand: () => ({
        harness: 'claude', commandBuilder: () => 'claude',
        createSession: async () => ({ command: 'claude', serverId: info.serverId }),
      }),
      discard: {
        killSession: async () => { discarded++; },
        cleanupWorktree: async () => { discarded++; return true; },
      },
    } });
  };
  const work = f.execute();
  await reached.promise;
  assert.equal((await getTask(task.id))?.status, 'in_progress');
  cancelWorkflowRun(f.run.id);
  const after = f.events.length;
  admission.resolve(null);
  await work;
  assert.equal((await getTask(task.id))?.status, 'in_progress');
  assert.equal(discarded, 0);
  assert.equal(signals[0].aborted, false);
  assert.equal(f.calls.enqueues, 0);
  assert.equal(f.events.filter((ev) => ev.type === 'workflow-task-spawned').length, 1);
  assertNoLateProgress(f.events, after);
});

for (const result of ['success', 'capacity', 'disk', 'failure'] as const) {
  test(`a settled ${result} direct start releases its cancellation subscription`, async (t) => {
    const f = fixture(t);
    const signals: AbortSignal[] = [];
    f.deps.startTask = async (_id, _origin, options) => {
      assert.ok(options?.signal);
      signals.push(options.signal);
      if (result === 'capacity') throw new SpawnCapacityError('cap');
      if (result === 'disk') throw new SpawnDiskSpaceError('disk reserve', 1000);
      if (result === 'failure') throw new Error('setup failed');
      return spawned(f.task);
    };
    if (result === 'failure') await assert.rejects(f.execute(), /all 1 task\(s\) failed/);
    else await f.execute();
    assert.deepEqual(f.subscriptions, { active: 0, removed: 1 });
    const after = f.events.length;
    cancelWorkflowRun(f.run.id);
    assert.equal(signals[0].aborted, false, 'finished launches/admissions no longer belong to the step');
    assertNoLateProgress(f.events, after);
  });
}

test('a cancelled Start worker releases the project lock and never advances on a late deferral', async (t) => {
  const f = fixture(t);
  const reached = deferred<void>();
  const allocation = deferred<StartTaskByIdResult>();
  f.deps.startTask = () => { reached.resolve(); return allocation.promise; };
  let releases = 0;
  let completions = 0;
  const work = runControlStepWorker(f.wf, f.run, 0, ORIGIN, async () => { completions++; }, {
    waitForRepoMaintenance: async () => true,
    acquireLock: async () => ({ release: async () => { releases++; } }),
    runStart: () => f.execute(), runMerge: async () => {}, runPush: async () => {},
  });
  await reached.promise;
  cancelWorkflowRun(f.run.id);
  allocation.reject(new SpawnDiskSpaceError('late disk rejection', 1000));
  await work;
  assert.equal(releases, 1);
  assert.equal(completions, 0);
  assert.equal(f.run.status, 'cancelled');
  assert.equal(f.run.error, undefined);
  assert.equal(f.calls.enqueues, 0);
  assert.equal(f.subscriptions.active, 0);
});
