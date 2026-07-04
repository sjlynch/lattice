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
    assert.match((result as { err: Error }).err.message, /did not drain within 1000ms/);
    assert.match((result as { err: Error }).err.message, /run-lock is released/);
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
          'waitForLaneEmpty: lane "in_progress" did not drain within 1000ms — ' +
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
