import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMergeStep, type MergeStepDeps } from '../workflowRuns/controlSteps/merge.js';
import { waitForPostMergeHookIdle } from '../workflowRuns/controlSteps/shared.js';
import {
  beginPostMergeHookTrigger,
  hasPendingPostMergeHookTrigger,
  subscribePostMergeHookTriggers,
  type PostMergeHookEvent,
  type PostMergeHookRun,
} from '../postMergeHooks.js';
import type { Task } from '../tasks.js';
import type { MergeRun } from '../mergeRuns/state.js';
import type { Workflow } from '../workflows.js';
import type { WorkflowRun, WorkflowRunEvent } from '../workflowRuns/state.js';

// Regression for: "a queued workflow's step 1 starts while the PREVIOUS
// workflow's post-merge hook is still running."
//
// A hook fired by a merge run is gated already — mergeRuns.ts awaits
// runPostMergeHook before finishRun, so the Merge step's waitForMergeRunFinished
// transitively waits it out. But `awaitPostMergeHookOutsideRun`
// (routes/tasks/hooks/: the resolver `/complete` branch, `/merged`,
// `/stash-resolved`) fires a hook precisely when NO merge run is active, so no
// run's finishRun gates it. Without Phase C the Merge step reported "merge
// complete", the workflow run finished, and the frontend queue — whose only
// sequential gate (`assertNoActiveWorkflowRun`) counts workflow runs and not
// hooks — dispatched the next workflow on top of the live hook.

const PROJECT = '/project';

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

function makeHook(over: Partial<PostMergeHookRun> = {}): PostMergeHookRun {
  return {
    id: 'pmh_1',
    projectPath: PROJECT,
    harness: 'claude',
    prompt: 'do the thing',
    cwd: '/scratch/pmh_1',
    status: 'running',
    startedAt: 1,
    trigger: 'manual-merge',
    ...over,
  };
}

function makeMergeRun(id: string): MergeRun {
  return {
    id,
    projectPath: PROJECT,
    status: 'completed',
    startedAt: 1,
    total: 1,
    processed: 1,
    merged: ['A'],
    conflicted: [],
    errored: [],
    cancelRequested: false,
  };
}

// One ready task that merges clean on round 1, so Phase B does exactly one
// round and then reaches Phase C.
function makeMergeDeps(
  waitForPostMergeHookIdleFn: MergeStepDeps['waitForPostMergeHookIdle'],
): MergeStepDeps {
  let tasks: Task[] = [
    {
      id: 'A',
      projectPath: PROJECT,
      title: 'a',
      status: 'ready_to_merge',
      createdAt: 1,
      branch: 'lattice/a',
      worktreePath: '/wt/a',
    } as Task,
  ];
  const finished = new Map<string, MergeRun>();

  return {
    listTasks: async () => tasks,
    startMergeRun: async () => {
      tasks = [];
      const run = makeMergeRun('mr_1');
      finished.set(run.id, run);
      return run;
    },
    getMergeRun: (id) => finished.get(id) ?? null,
    cancelMergeRun: () => false,
    subscribeMergeRuns: () => () => undefined,
    subscribeWorkflowRuns: () => () => undefined,
    waitForMergeWork: async () => tasks,
    waitForPostMergeHookIdle: waitForPostMergeHookIdleFn,
  };
}

test('merge step does not complete until the post-merge hook gate resolves', async () => {
  const order: string[] = [];
  let releaseHook: () => void = () => undefined;
  const hookDone = new Promise<void>((resolve) => {
    releaseHook = resolve;
  });

  const deps = makeMergeDeps(async () => {
    order.push('gate-entered');
    await hookDone;
    order.push('gate-resolved');
  });

  const stepPromise = runMergeStep(makeWorkflow(), makeRun(), 0, 'http://x', deps);

  // Let Phase A + Phase B run to completion and park in Phase C.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['gate-entered'], 'step must reach the hook gate');

  // The step must still be pending — this is the whole point. Before the fix it
  // resolved here and the workflow run completed, freeing the queue's slot.
  let settled = false;
  void stepPromise.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, 'merge step must not complete while a hook runs');

  releaseHook();
  await stepPromise;
  assert.deepEqual(order, ['gate-entered', 'gate-resolved']);
});

test('merge step surfaces a wedged post-merge hook as an error (lock released)', async () => {
  // The gate rejects on its bounded-wait expiry; the step must propagate that
  // so runControlStepWorker's finally releases the project run-lock rather than
  // hanging forever.
  const deps = makeMergeDeps(async () => {
    throw new Error('waitForPostMergeHookIdle: post-merge hook pmh_1 did not finish');
  });

  await assert.rejects(
    () => runMergeStep(makeWorkflow(), makeRun(), 0, 'http://x', deps),
    /did not finish/,
  );
});

test('merge step passes its own project + workflow run into the gate', async () => {
  const seen: { project?: string; runId?: string } = {};
  const deps = makeMergeDeps(async (projectPath, run) => {
    seen.project = projectPath;
    seen.runId = run.id;
  });

  await runMergeStep(makeWorkflow(), makeRun(), 0, 'http://x', deps);
  assert.equal(seen.project, PROJECT);
  assert.equal(seen.runId, 'wfrun_test');
});

// --- the gate primitive itself -------------------------------------------

test('waitForPostMergeHookIdle resolves immediately when no hook is running', async () => {
  await waitForPostMergeHookIdle(PROJECT, makeRun(), () => undefined, 1000, {
    getActiveHookForProject: () => null,
    subscribePostMergeHooks: () => () => undefined,
    subscribeRun: () => () => undefined,
  });
});

test('waitForPostMergeHookIdle catches a hook that starts during the initial idle turn', async () => {
  let active: PostMergeHookRun | null = null;
  let emit: ((ev: PostMergeHookEvent) => void) | null = null;
  const gate = waitForPostMergeHookIdle(PROJECT, makeRun(), () => undefined, 1000, {
    getActiveHookForProject: () => active,
    subscribePostMergeHooks: (fn) => {
      emit = fn;
      return () => undefined;
    },
    subscribeRun: () => () => undefined,
  });

  // A task finalizer can publish its QA transition (waking the Merge step)
  // immediately before it records the post-merge hook. The first idle read
  // must not resolve/unsubscribe so eagerly that this started event is lost.
  active = makeHook();
  emit!({ type: 'started', run: active });

  let settled = false;
  void gate.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, 'the just-started hook must keep Phase C closed');

  const completed = makeHook({ status: 'completed' });
  active = null;
  emit!({ type: 'finished', run: completed });
  await gate;
});

test('waitForPostMergeHookIdle blocks while a trigger is reading settings before record', async () => {
  const endPending = beginPostMergeHookTrigger(PROJECT);
  const gate = waitForPostMergeHookIdle(PROJECT, makeRun(), () => undefined, 1000, {
    getActiveHookForProject: () => null,
    subscribePostMergeHooks: () => () => undefined,
    subscribeRun: () => () => undefined,
    hasPendingPostMergeHookTrigger,
    subscribePostMergeHookTriggers,
  });

  let settled = false;
  void gate.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, 'the pre-record trigger window must keep Phase C closed');

  endPending();
  await gate;
});

test('waitForPostMergeHookIdle blocks until the running hook finishes', async () => {
  let active: PostMergeHookRun | null = makeHook();
  let emit: ((ev: PostMergeHookEvent) => void) | null = null;
  const reported: PostMergeHookRun[] = [];
  let unsubscribed = false;

  const gate = waitForPostMergeHookIdle(
    PROJECT,
    makeRun(),
    (hook) => reported.push(hook),
    1000,
    {
      getActiveHookForProject: () => active,
      subscribePostMergeHooks: (fn) => {
        emit = fn;
        return () => {
          unsubscribed = true;
        };
      },
      subscribeRun: () => () => undefined,
    },
  );

  let settled = false;
  void gate.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, 'must block while the hook is running');
  assert.equal(reported.length, 1, 'reports the hook it is waiting on');
  assert.equal(reported[0].id, 'pmh_1');

  // A `progress` event while still running must not release the gate, and must
  // not re-report (the run strip would otherwise get duplicate lines).
  emit!({ type: 'progress', run: makeHook() });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
  assert.equal(reported.length, 1, 'reports each waited-on hook only once');

  // A *different* hook taking over (one finishes, another fires before we
  // re-check) keeps the gate shut and gets its own progress line.
  active = makeHook({ id: 'pmh_2' });
  emit!({ type: 'started', run: makeHook({ id: 'pmh_2' }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, 'a second hook must keep the gate shut');
  assert.deepEqual(
    reported.map((h) => h.id),
    ['pmh_1', 'pmh_2'],
    'each distinct hook is reported once',
  );

  active = null;
  emit!({ type: 'finished', run: makeHook({ id: 'pmh_2', status: 'completed' }) });
  await gate;
  assert.equal(unsubscribed, true, 'gate unsubscribes on resolve');
});

test('waitForPostMergeHookIdle rejects when the hook never finishes (bounded wait)', async () => {
  await assert.rejects(
    () =>
      waitForPostMergeHookIdle(PROJECT, makeRun(), () => undefined, 20, {
        getActiveHookForProject: () => makeHook(),
        subscribePostMergeHooks: () => () => undefined,
        subscribeRun: () => () => undefined,
      }),
    /did not finish within 20ms[\s\S]*run-lock is released/,
  );
});

test('waitForPostMergeHookIdle resolves on workflow-run cancellation', async () => {
  const run = makeRun();
  let emitRun: ((ev: WorkflowRunEvent) => void) | null = null;

  const gate = waitForPostMergeHookIdle(PROJECT, run, () => undefined, 1000, {
    // Hook stays running forever — only the cancel should free us.
    getActiveHookForProject: () => makeHook(),
    subscribePostMergeHooks: () => () => undefined,
    subscribeRun: (fn) => {
      emitRun = fn;
      return () => undefined;
    },
  });

  run.status = 'cancelled';
  emitRun!({ type: 'cancelled', run });
  await gate;
});

test('waitForPostMergeHookIdle re-checks after subscribing so a fast finish is not missed', async () => {
  // Mirrors waitForMergeRunFinished's race guard: the hook finishes in the gap
  // between subscribe and the initial read. Subscribing first + evaluating
  // after is what makes this resolve instead of parking forever.
  let active: PostMergeHookRun | null = makeHook();
  await waitForPostMergeHookIdle(PROJECT, makeRun(), () => undefined, 500, {
    getActiveHookForProject: () => active,
    subscribePostMergeHooks: () => {
      active = null;
      return () => undefined;
    },
    subscribeRun: () => () => undefined,
  });
});

// --- Phase C's owed-hook fire honours a workflow cancel ----------------------
//
// `fireOwedPostMergeHook` → `runPostMergeHookGate` has no cancel signal: it
// waits on the hook agent (up to 30 min, 3 rounds on repeated already-running).
// A cancel during that wait left the step's worker parked with the
// `workflow-merge:*` run.lock held — Merge All 409ing, the dev runner deferring
// restarts — until the hook finished.

test('a workflow cancel during the owed-hook fire returns the step at once', async () => {
  let idleGateCalls = 0;
  const deps = makeMergeDeps(async () => {
    idleGateCalls += 1;
  });
  const listeners = new Set<(ev: WorkflowRunEvent) => void>();
  deps.subscribeWorkflowRuns = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  let fired = 0;
  const seen: { shouldStop?: () => boolean } = {};
  deps.fireOwedPostMergeHook = (_project, _origin, stop) => {
    fired += 1;
    seen.shouldStop = stop;
    return new Promise<void>(() => undefined); // the hook never finishes
  };

  const run = makeRun();
  let settled = false;
  const stepPromise = runMergeStep(makeWorkflow(), run, 0, 'http://x', deps).then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, 1, 'Phase C fired the owed hook');
  assert.equal(settled, false, 'the step waits on it while the run is live');
  assert.equal(seen.shouldStop?.(), false);

  run.status = 'cancelled';
  for (const fn of [...listeners]) fn({ type: 'cancelled', run });

  await Promise.race([
    stepPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('step still parked after cancel')), 500)),
  ]);
  assert.equal(settled, true, 'the step returned, so its worker releases the run lock');
  assert.equal(seen.shouldStop?.(), true, 'the gate is told to fire nothing further');
  assert.equal(idleGateCalls, 0, 'a cancelled step does not go on to the idle wait');
  assert.equal(listeners.size, 0, 'every workflow-run subscription was dropped');
});
