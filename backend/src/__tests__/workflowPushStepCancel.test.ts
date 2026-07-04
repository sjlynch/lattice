import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import { subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { StartedPushSession } from '../pushRuns.js';
import type { Workflow } from '../workflows.js';

// Regression for Fix 3: "cancelling a workflow during the push-step spawn window
// still pushes to the remote and orphans the PTY." The cancel handler killed
// only `sessionServerId`, but that is assigned only AFTER startPushSession
// resolves. A cancel fired WHILE startPushSession is in flight therefore killed
// nothing — the push Claude/PTY went live, `git push` ran to completion despite
// the cancel, and the session was only reaped by its own Stop hook/timeout. The
// fix re-checks a `cancelled` flag / run.status after the spawn resolves and
// kills the pty, mirroring the existing post-spawn 'already done' guard.

const PROJECT = '/project';

function makeRun(): WorkflowRun {
  return {
    id: 'wfrun_push_cancel',
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: PROJECT,
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

function makeWorkflow(): Workflow {
  return { projectPath: PROJECT } as Workflow;
}

async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitFor: condition never became true');
}

test('cancelling mid-startPushSession kills the resolved session and never reports push complete', async () => {
  const run = makeRun();

  let startPushCalled = false;
  let resolvePush!: (s: StartedPushSession) => void;
  // A holder (property access) instead of a bare `let` so TS doesn't narrow the
  // callback-assigned reference to `never` after the await.
  const holder = { cancel: undefined as ((ev: WorkflowRunEvent) => void) | undefined };
  const killed: string[] = [];

  const deps: PushStepDeps = {
    // Ready-to-Merge is already empty.
    waitForLaneEmpty: async () => undefined,
    // Never fires 'done' in this scenario.
    subscribePushRuns: () => () => undefined,
    // Capture the workflow-run cancel subscriber so the test can fire it.
    subscribeWorkflowRuns: (cb) => {
      holder.cancel = cb;
      return () => undefined;
    },
    // Stays in flight until the test resolves it — the cancel fires in between.
    startPushSession: () => {
      startPushCalled = true;
      return new Promise<StartedPushSession>((resolve) => {
        resolvePush = resolve;
      });
    },
    getPushRun: () => undefined,
    proxyKillSession: async (serverId: string) => {
      killed.push(serverId);
      return true;
    },
  };

  // Observe the real workflow-run bus for 'push complete' / step-spawned.
  const progressMessages: string[] = [];
  let stepSpawned = false;
  const unsub = subscribe((ev: WorkflowRunEvent) => {
    if (ev.type === 'step-control-progress' && ev.message) progressMessages.push(ev.message);
    if (ev.type === 'step-spawned') stepSpawned = true;
  });

  try {
    const stepPromise = runPushStep(makeWorkflow(), run, 0, 'http://localhost', deps);

    // Wait until runPushStep is parked awaiting startPushSession, then cancel
    // the run mid-flight (serverId is still unknown at this point).
    await waitFor(() => startPushCalled);
    assert.ok(holder.cancel, 'the push step must subscribe to workflow-run events');
    run.status = 'cancelled';
    holder.cancel({ type: 'cancelled', run });

    // Now the spawn resolves — the pty exists and must be killed by the
    // post-spawn re-check because the run was cancelled.
    resolvePush({ id: 'push_1', serverId: 'srv-push-1', command: 'claude', cwd: '/scratch' });

    await stepPromise;
  } finally {
    unsub();
  }

  assert.deepEqual(
    killed,
    ['srv-push-1'],
    'a cancelled push must kill the resolved session pty',
  );
  assert.ok(
    !progressMessages.includes('push complete'),
    'a cancelled push must not report push complete',
  );
  assert.equal(stepSpawned, false, 'a cancelled push must not surface the push terminal');
});

test('a normal (uncancelled) push completes and reports push complete', async () => {
  const run = makeRun();
  const killed: string[] = [];

  const deps: PushStepDeps = {
    waitForLaneEmpty: async () => undefined,
    subscribePushRuns: () => () => undefined,
    subscribeWorkflowRuns: () => () => undefined,
    startPushSession: async () => ({
      id: 'push_ok',
      serverId: 'srv-ok',
      command: 'claude',
      cwd: '/scratch',
    }),
    // The run is already 'done' by the time we look — the post-spawn
    // belt-and-suspenders guard resolves the wait deterministically (no timing
    // dependency on a fired event).
    getPushRun: () =>
      ({
        id: 'push_ok',
        projectPath: PROJECT,
        cwd: '/scratch',
        status: 'done',
        createdAt: 1,
      }) as ReturnType<PushStepDeps['getPushRun']>,
    proxyKillSession: async (serverId: string) => {
      killed.push(serverId);
      return true;
    },
  };

  const progressMessages: string[] = [];
  const unsub = subscribe((ev: WorkflowRunEvent) => {
    if (ev.type === 'step-control-progress' && ev.message) progressMessages.push(ev.message);
  });

  try {
    await runPushStep(makeWorkflow(), run, 0, 'http://localhost', deps);
  } finally {
    unsub();
  }

  assert.deepEqual(killed, [], 'a normal push kills nothing');
  assert.ok(
    progressMessages.includes('push complete'),
    'a normal push reports push complete',
  );
});
