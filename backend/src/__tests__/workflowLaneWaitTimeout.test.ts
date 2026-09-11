import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForLaneEmpty,
  type LaneWaitDeps,
} from '../workflowRuns/controlSteps/shared.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import type { Task } from '../tasks.js';
import type { Workflow } from '../workflows.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import type { ProjectRunLockHandle } from '../projectRunLock.js';

// Regression for Fix 2: "waitForLaneEmpty has no timeout — a merge/push control
// step can hang forever holding the cross-process project run-lock." If a task
// is stuck in the drained lane (its agent died without committing, which the
// in-progress sweep refuses to auto-complete), the lane never empties, the
// control-step worker never returns, its finally never runs, and the project
// run.lock stays held forever — blocking all future merge runs / control steps.
// The fix gives waitForLaneEmpty a bounded max-wait that REJECTS on expiry so
// the worker's catch errors the run and its finally releases the lock.
//
// Follow-up regression: the bound is a NO-PROGRESS timeout, not a total one. A
// fixed total timeout erroring a lane that is still steadily draining stranded a
// whole workflow's completed tasks — the Merge step's Phase A 30-min wall clock
// fired ~5s before the last of 29 codex tasks finished, so Phase B never merged.
// The last test here pins that a lane which keeps draining (past maxWaitMs in
// total, but never idle for a full window) must NOT time out.

const PROJECT = '/project';

function makeRun(): WorkflowRun {
  return {
    id: 'wfrun_lane',
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: PROJECT,
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

function stuckTask(): Task {
  return {
    id: 'stuck',
    projectPath: PROJECT,
    title: 'stuck',
    status: 'in_progress',
    createdAt: 1,
  } as Task;
}

test('waitForLaneEmpty rejects on timeout when the lane never drains', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // The lane always reports one in_progress task and never notifies a change.
    const deps: LaneWaitDeps = {
      listTasks: async () => [stuckTask()],
      subscribeTasks: () => () => undefined,
      subscribeRun: () => () => undefined,
    };

    const p = waitForLaneEmpty(PROJECT, makeRun(), 'in_progress', () => {}, 1000, deps);
    // Convert to a settled tag so ticking can't produce an unhandled rejection.
    const settled = p.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );

    // Let the initial listTasks().then microtask run (count stays 1 → no drain).
    await Promise.resolve();
    await Promise.resolve();

    // Fire the backstop.
    mock.timers.tick(1000);

    const result = await settled;
    assert.equal(result.ok, false, 'a never-draining lane must reject, not hang');
    assert.match((result as { err: Error }).err.message, /made no progress for 1000ms/);
    assert.match((result as { err: Error }).err.message, /run-lock is released/);
  } finally {
    mock.timers.reset();
  }
});

test('waitForLaneEmpty does NOT time out while the lane keeps draining (no-progress semantics)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // A controllable subscription so we can drip the lane down over a total
    // span well past maxWaitMs, one task at a time, each within a window.
    let push: ((tasks: Task[]) => void) | null = null;
    const lane = (n: number): Task[] =>
      Array.from({ length: n }, (_, i) => ({ ...stuckTask(), id: `t${i}` }));
    const deps: LaneWaitDeps = {
      listTasks: async () => lane(3),
      subscribeTasks: (cb) => {
        push = (tasks) => cb(PROJECT, tasks);
        return () => {
          push = null;
        };
      },
      subscribeRun: () => () => undefined,
    };

    const p = waitForLaneEmpty(PROJECT, makeRun(), 'in_progress', () => {}, 1000, deps);
    const settled = p.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );

    // Initial read: count 3 → arms the no-progress timer (deadline t=1000).
    await Promise.resolve();
    await Promise.resolve();

    // Each drain lands BEFORE the current deadline and re-arms it. Total elapsed
    // reaches 2400ms — 2.4× maxWaitMs — yet it must not reject.
    mock.timers.tick(800); // t=800  (deadline was 1000)
    push!(lane(2)); //          drain → re-arm, deadline t=1800
    mock.timers.tick(800); // t=1600 (< 1800)
    push!(lane(1)); //          drain → re-arm, deadline t=2600
    mock.timers.tick(800); // t=2400 (< 2600)
    push!(lane(0)); //          lane empty → resolve

    const result = await settled;
    assert.equal(
      result.ok,
      true,
      'a steadily-draining lane must resolve, never trip the no-progress timeout',
    );
  } finally {
    mock.timers.reset();
  }
});

test('waitForLaneEmpty resolves (and clears the timer) when the lane is already empty', async () => {
  // maxWaitMs is set but the lane is empty on the first read → resolves at once.
  const deps: LaneWaitDeps = {
    listTasks: async () => [],
    subscribeTasks: () => () => undefined,
    subscribeRun: () => () => undefined,
  };
  await waitForLaneEmpty(PROJECT, makeRun(), 'in_progress', () => {}, 1000, deps);
});

test('a rejected initial lane read rejects the waiter and releases its subscriptions', async () => {
  let unsubscribed = 0;
  const deps: LaneWaitDeps = {
    listTasks: async () => { throw new Error('task store read failed'); },
    subscribeTasks: () => () => { unsubscribed += 1; },
    subscribeRun: () => () => { unsubscribed += 1; },
  };
  await assert.rejects(waitForLaneEmpty(PROJECT, makeRun(), 'in_progress', () => {}, 1000, deps),
    /task store read failed/);
  assert.equal(unsubscribed, 2);
});

test('lane progress exceptions reject the waiter instead of escaping a store subscriber', async () => {
  let push!: (tasks: Task[]) => void;
  let unsubscribed = 0;
  const deps: LaneWaitDeps = {
    listTasks: async () => [stuckTask()],
    subscribeTasks: (cb) => {
      push = (tasks) => cb(PROJECT, tasks);
      return () => { unsubscribed += 1; };
    },
    subscribeRun: () => () => { unsubscribed += 1; },
  };
  let progressCalls = 0;
  const waiting = waitForLaneEmpty(PROJECT, makeRun(), 'in_progress', () => {
    if (++progressCalls > 1) throw new Error('progress subscriber failed');
  }, 1000, deps);
  const rejected = assert.rejects(waiting, /progress subscriber failed/);
  await Promise.resolve();
  push([stuckTask()]);
  await rejected;
  assert.equal(unsubscribed, 2);
});

test('the lane wait timeout also bounds an initial task read that never settles', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const deps: LaneWaitDeps = {
      listTasks: () => new Promise(() => {}),
      subscribeTasks: () => () => undefined,
      subscribeRun: () => () => undefined,
    };
    const rejected = assert.rejects(
      waitForLaneEmpty(PROJECT, makeRun(), 'in_progress', () => {}, 1000, deps),
      /made no progress for 1000ms/,
    );
    mock.timers.tick(1000);
    await rejected;
  } finally {
    mock.timers.reset();
  }
});

test('a failed initial lane read errors only its workflow and releases the project lock', async () => {
  const release = mock.fn(async () => undefined);
  const run = makeRun();
  const wf = { projectPath: PROJECT, steps: [{ kind: 'merge' }] } as Workflow;
  const deps: LaneWaitDeps = {
    listTasks: async () => { throw new Error('task read failed during recovery'); },
    subscribeTasks: () => () => undefined,
    subscribeRun: () => () => undefined,
  };
  let completed = false;
  await runControlStepWorker(wf, run, 0, 'http://localhost', async () => { completed = true; }, {
    acquireLock: async () => ({ release }),
    runStart: async () => undefined,
    runMerge: () => waitForLaneEmpty(PROJECT, run, 'in_progress', () => {}, 1000, deps),
    runPush: async () => undefined,
  });
  assert.equal(release.mock.callCount(), 1);
  assert.equal(run.status, 'errored');
  assert.match(run.error ?? '', /task read failed during recovery/);
  assert.equal(completed, false);
});

test("a control-step worker releases the project run-lock when the lane-wait times out", async () => {
  // Simulate the whole worker: a merge step whose Phase A drain rejects the way
  // the timeout does. The lock must still be released (its run.lock freed) and
  // the run must NOT advance to the next step.
  const release = mock.fn(async () => undefined);
  const lock: ProjectRunLockHandle = { release };
  let completeCalls = 0;

  const wf = { projectPath: PROJECT, steps: [{ kind: 'merge' }] } as Workflow;
  const run = makeRun();

  await runControlStepWorker(
    wf,
    run,
    0,
    'http://localhost',
    async () => {
      completeCalls += 1;
    },
    {
      acquireLock: async () => lock,
      runStart: async () => undefined,
      runMerge: async () => {
        throw new Error(
          'waitForLaneEmpty: lane "in_progress" made no progress for 1000ms — ' +
            'aborting so the project run-lock is released',
        );
      },
      runPush: async () => undefined,
    },
  );

  assert.equal(release.mock.callCount(), 1, 'the run-lock must be released even on a worker throw');
  assert.equal(run.status, 'errored', 'a lane-wait timeout errors the run');
  assert.equal(completeCalls, 0, 'an errored control step must not advance to the next step');
});
