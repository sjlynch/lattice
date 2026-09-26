import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMergeStep,
  waitForMergeRunFinished,
  type MergeStepDeps,
} from '../workflowRuns/controlSteps/merge.js';
import type { Task } from '../tasks.js';
import type { MergeRun } from '../mergeRuns/state.js';
import type { Workflow } from '../workflows.js';
import type { WorkflowRun } from '../workflowRuns/state.js';

// Regression for: "workflow Merge control step infinite-loops on
// persistently-erroring tasks after partial progress." Phase B loops merge
// runs until ready_to_merge is empty. Tasks that error every round (no
// branch/worktree, held merge lock, uncaught per-task error) are pushed to the
// run's `errored` list but LEFT at ready_to_merge by processTarget, so they
// reappear every round. The old guard only tripped when the per-round error
// COUNT strictly increased; but each startMergeRun builds a fresh MergeRun with
// `errored: []`, so a steady error count slipped past it and the step spun
// forever. The step must instead abort the moment a round leaves the
// ready_to_merge id-set unchanged (no task left the lane).

const PROJECT = '/project';

function makeTask(over: Partial<Task>): Task {
  return {
    id: 'task',
    projectPath: PROJECT,
    title: 'task',
    status: 'ready_to_merge',
    createdAt: 1,
    ...over,
  } as Task;
}

function makeWorkflow(): Workflow {
  return { projectPath: PROJECT } as Workflow;
}

function makeRun(): WorkflowRun {
  return {
    id: 'wfrun_test',
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: PROJECT,
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

function makeMergeRun(id: string, errored: string[]): MergeRun {
  return {
    id,
    projectPath: PROJECT,
    status: 'completed',
    startedAt: 1,
    total: 0,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: errored.map((taskId) => ({ taskId, error: 'no worktree' })),
    cancelRequested: false,
  };
}

// Build a deps bag that simulates a merge run against a shared, mutable task
// list. `merge(round, tasks)` mutates the list to reflect what that round
// accomplished and returns the ids it errored on. A hard `maxRounds` ceiling
// converts the OLD infinite-loop bug into a *distinct* sentinel rejection so a
// regression surfaces as an assertion failure instead of a hung test.
function makeDeps(
  initialTasks: Task[],
  merge: (round: number, tasks: Task[]) => string[],
  maxRounds = 6,
): { deps: MergeStepDeps; rounds: () => number } {
  let tasks = [...initialTasks];
  let round = 0;
  const finished = new Map<string, MergeRun>();

  const deps: MergeStepDeps = {
    listTasks: async () => tasks,
    startMergeRun: async () => {
      round += 1;
      if (round > maxRounds) {
        throw new Error(`SENTINEL: merge step looped past ${maxRounds} rounds`);
      }
      const errored = merge(round, tasks);
      tasks = tasks.filter((t) => t.status === 'ready_to_merge');
      const run = makeMergeRun(`mr_${round}`, errored);
      finished.set(run.id, run);
      return run;
    },
    getMergeRun: (id) => finished.get(id) ?? null,
    cancelMergeRun: () => false,
    subscribeMergeRuns: () => () => undefined,
    subscribeWorkflowRuns: () => () => undefined,
    waitForMergeWork: async () => tasks, // No queued/running tasks in this fixture
    waitForPostMergeHookIdle: async () => undefined, // Phase C: no hook configured
  };

  return { deps, rounds: () => round };
}

test('merge step aborts within two rounds when the ready_to_merge lane stops shrinking', async () => {
  // A merges clean (leaves the lane round 1); B and C have no branch/worktree
  // so they error every round and stay ready_to_merge forever.
  const initial = [
    makeTask({ id: 'A', branch: 'lattice/a', worktreePath: '/wt/a' }),
    makeTask({ id: 'B' }),
    makeTask({ id: 'C' }),
  ];

  const { deps, rounds } = makeDeps(initial, (round, tasks) => {
    if (round === 1) {
      // A finalizes → leaves the lane; B + C error.
      const a = tasks.find((t) => t.id === 'A');
      if (a) a.status = 'qa';
      return ['B', 'C'];
    }
    // Round 2+: B + C error again, nothing leaves the lane.
    return ['B', 'C'];
  });

  await assert.rejects(
    () => runMergeStep(makeWorkflow(), makeRun(), 0, 'http://localhost', deps),
    // …and names the first task error, not just a count.
    /made no progress[\s\S]*ready-to-merge[\s\S]*task B: no worktree/,
  );

  // It must abort on the SECOND round (the first made progress, the second
  // did not) — not loop into the sentinel ceiling.
  assert.equal(rounds(), 2, 'should abort after exactly two merge runs');
});

test('merge step drains the lane and completes when every round makes progress', async () => {
  // Two clean tasks: round 1 merges A, round 2 merges B, then the lane is empty.
  const initial = [
    makeTask({ id: 'A', branch: 'lattice/a', worktreePath: '/wt/a' }),
    makeTask({ id: 'B', branch: 'lattice/b', worktreePath: '/wt/b' }),
  ];

  const { deps, rounds } = makeDeps(initial, (round, tasks) => {
    const victim = round === 1 ? 'A' : 'B';
    const t = tasks.find((x) => x.id === victim);
    if (t) t.status = 'qa';
    return [];
  });

  // Resolves (no throw) — the lane drains to empty.
  await runMergeStep(makeWorkflow(), makeRun(), 0, 'http://localhost', deps);
  assert.equal(rounds(), 2, 'two productive rounds, then the empty lane breaks');
});

test('merge step is a no-op when the ready_to_merge lane is already empty', async () => {
  const { deps, rounds } = makeDeps([], () => []);
  await runMergeStep(makeWorkflow(), makeRun(), 0, 'http://localhost', deps);
  assert.equal(rounds(), 0, 'no merge run started for an empty lane');
});

test('waitForMergeRunFinished re-checks after subscribing so fast completion is not missed', async () => {
  const run = makeMergeRun('mr_race', []);
  run.status = 'running';
  let subscribed = false;
  let unsubscribed = false;

  const deps = {
    getMergeRun: (id: string) => (id === run.id ? { ...run } : null),
    subscribeMergeRuns: () => {
      subscribed = true;
      // Simulate the old race window: a worker completes after a caller's
      // first snapshot observes `running`, but before its event listener is
      // actually installed/able to observe the completion event. The fixed
      // waiter subscribes first, then re-checks this completed snapshot.
      run.status = 'completed';
      return () => {
        unsubscribed = true;
      };
    },
  };

  await Promise.race([
    waitForMergeRunFinished(run.id, deps),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
  ]);
  assert.equal(subscribed, true);
  assert.equal(unsubscribed, true);
});

test('workflow cancellation during inner merge startup cancels the returned worker and waits for its teardown', async () => {
  const workflow = makeWorkflow();
  const run = makeRun();
  const inner = makeMergeRun('mr_cancel_start', []);
  inner.status = 'running';
  const { deps } = makeDeps([makeTask({ id: 'A' })], () => []);
  const cancelled: string[] = [];
  let completeWorker!: () => void;
  deps.startMergeRun = async () => {
    // A cancel arrives while acquisition / task loading is in flight, before
    // runMergeStep knows the returned worker ID.
    run.status = 'cancelled';
    return inner;
  };
  deps.getMergeRun = () => inner;
  deps.cancelMergeRun = (id) => { cancelled.push(id); return true; };
  deps.subscribeMergeRuns = (listener) => {
    completeWorker = () => {
      inner.status = 'cancelled';
      listener({ type: 'cancelled', run: inner });
    };
    return () => undefined;
  };
  let settled = false;
  const pending = runMergeStep(workflow, run, 0, 'http://unused', deps).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(cancelled, [inner.id]);
    assert.equal(settled, false, 'inherited project lock must remain held until the worker has stopped');
  } finally {
    completeWorker();
    await pending;
  }
});
