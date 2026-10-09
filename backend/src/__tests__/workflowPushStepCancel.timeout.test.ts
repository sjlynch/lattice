// The workflow Push step's 15-minute timeout. It used to kill the session and
// then report 'push complete', so the workflow advanced as if the push had
// landed. A timeout must reject, kill + settle the session, ERROR the run
// through the control-step worker (lock released, no advance), and a user
// cancel before the timeout must stay a cancel.
// Shared fixtures: helpers/workflowPushStepCancel.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import { subscribe, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { Workflow } from '../workflows.js';
import { makeRun, makeWorkflow, PROJECT, waitFor } from './helpers/workflowPushStepCancel.js';

// Regression: the 15-minute push timeout used to kill the session and then
// report 'push complete', so the workflow advanced as if the push had landed.
// A timeout must ERROR the run (via controlStep.ts's worker catch), still
// settle the killed push run, and a user cancel must stay a cancel.
function timeoutDeps(
  killed: string[],
  abandoned: string[],
  hooks: { spawned?: () => void; onWf?: (cb: (ev: WorkflowRunEvent) => void) => void } = {},
): PushStepDeps {
  return {
    waitForLaneEmpty: async () => undefined,
    subscribePushRuns: () => () => undefined,
    subscribeWorkflowRuns: (cb) => {
      hooks.onWf?.(cb);
      return () => undefined;
    },
    startPushSession: async () => {
      hooks.spawned?.();
      return { id: 'push_slow', serverId: 'srv-slow', command: 'claude', cwd: '/scratch' };
    },
    // The session never reaches its Stop hook.
    getPushRun: () =>
      ({ id: 'push_slow', projectPath: PROJECT, cwd: '/scratch', status: 'running', createdAt: 1 }) as ReturnType<
        PushStepDeps['getPushRun']
      >,
    proxyKillSession: async (serverId: string) => {
      killed.push(serverId);
      return true;
    },
    abandonPushRun: (_projectPath, id) => abandoned.push(id),
    pushTimeoutMs: 20,
  };
}

test('a push step that times out rejects, kills + settles the session, and never reports push complete', async () => {
  const run = makeRun();
  const killed: string[] = [];
  const abandoned: string[] = [];
  const progressMessages: string[] = [];
  const unsub = subscribe((ev: WorkflowRunEvent) => {
    if (ev.type === 'step-control-progress' && ev.message) progressMessages.push(ev.message);
  });
  try {
    await assert.rejects(
      runPushStep(makeWorkflow(), run, 0, 'http://localhost', timeoutDeps(killed, abandoned)),
      /push step timed out after 20ms/,
    );
  } finally {
    unsub();
  }
  assert.deepEqual(killed, ['srv-slow']);
  assert.deepEqual(abandoned, ['push_slow'], 'the abandonPushRun cleanup still runs');
  assert.ok(!progressMessages.includes('push complete'));
});

test('a push timeout errors the workflow run through the control-step worker and does not advance', async () => {
  const run = makeRun();
  const killed: string[] = [];
  const abandoned: string[] = [];
  let completeCalls = 0;
  let released = 0;
  const wf = { projectPath: PROJECT, steps: [{ kind: 'push' }] } as Workflow;
  await runControlStepWorker(
    wf,
    run,
    0,
    'http://localhost',
    async () => {
      completeCalls += 1;
    },
    {
      acquireLock: async () => ({
        release: async () => {
          released += 1;
        },
      }),
      runStart: async () => undefined,
      runMerge: async () => undefined,
      runPush: (w, r, i, origin) => runPushStep(w, r, i, origin, timeoutDeps(killed, abandoned)),
    },
  );
  assert.equal(run.status, 'errored');
  assert.match(run.error ?? '', /push step timed out/);
  assert.equal(completeCalls, 0, 'a timed-out push must not advance the run');
  assert.equal(released, 1, 'the project run-lock is released');
  assert.deepEqual(abandoned, ['push_slow']);
});

test('a cancel before the push timeout stays cancelled (no timeout error)', async () => {
  const run = makeRun();
  const killed: string[] = [];
  const abandoned: string[] = [];
  const holder = { cancel: undefined as ((ev: WorkflowRunEvent) => void) | undefined };
  let spawned = false;
  const deps = timeoutDeps(killed, abandoned, {
    spawned: () => {
      spawned = true;
    },
    onWf: (cb) => {
      holder.cancel = cb;
    },
  });
  deps.pushTimeoutMs = 60_000;
  const stepPromise = runPushStep(makeWorkflow(), run, 0, 'http://localhost', deps);
  await waitFor(() => spawned);
  await new Promise((resolve) => setImmediate(resolve));
  run.status = 'cancelled';
  holder.cancel!({ type: 'cancelled', run });
  await stepPromise; // resolves, does not reject
  assert.equal(run.status, 'cancelled');
  assert.deepEqual(killed, ['srv-slow']);
});
