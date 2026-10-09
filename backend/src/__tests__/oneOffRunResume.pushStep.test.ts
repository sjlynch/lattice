// A workflow Push step re-dispatched after a backend restart: before the
// one-off mirrors it spawned a SECOND push. It must re-attach to the
// re-adopted live push session (surfacing that pty, not a new one), fail
// rather than report success when that terminal is lost, and complete without
// pushing again when the push already finished (its /done beat the
// re-dispatch, or a push restored as lost then got its real /done).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PushRun, StartedPushSession } from '../pushRuns.js';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import { subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { Workflow } from '../workflows.js';

function pushStepRun(): WorkflowRun {
  return {
    id: 'wfrun_push_attach',
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: '/project',
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

function attachDeps(overrides: Partial<PushStepDeps>, onDone: { fire?: () => void }): PushStepDeps {
  const adopted: StartedPushSession = { id: 'push_1_aa', cwd: '/scratch', command: 'claude', serverId: 'srv-live' };
  return {
    findLivePushSession: (runId, stepIndex) =>
      runId === 'wfrun_push_attach' && stepIndex === 0 ? adopted : undefined,
    startPushSession: async () => {
      throw new Error('a re-dispatched Push step must not spawn a second push');
    },
    waitForLaneEmpty: async () => {
      throw new Error('the drain already happened before the restart');
    },
    subscribePushRuns: (fn) => {
      onDone.fire = () => fn({ type: 'done', run: { id: 'push_1_aa' } as PushRun });
      return () => undefined;
    },
    subscribeWorkflowRuns: () => () => undefined,
    getPushRun: () => ({ id: 'push_1_aa', status: 'running' }) as PushRun,
    proxyKillSession: async () => true,
    ...overrides,
  };
}

test('a re-dispatched Push step re-attaches to the live push session instead of pushing twice', async () => {
  const run = pushStepRun();
  const holder: { fire?: () => void } = {};
  const progress: string[] = [];
  const spawnedServers: (string | undefined)[] = [];
  const unsub = subscribe((ev: WorkflowRunEvent) => {
    if (ev.type === 'step-control-progress' && ev.message) progress.push(ev.message);
    if (ev.type === 'step-spawned') spawnedServers.push(ev.serverId);
  });
  try {
    const step = runPushStep({ projectPath: '/project' } as Workflow, run, 0, 'http://x', attachDeps({}, holder));
    for (let i = 0; i < 50 && !holder.fire; i++) await new Promise((r) => setImmediate(r));
    assert.ok(holder.fire, 'the step waits on the adopted session');
    holder.fire!();
    await step;
  } finally {
    unsub();
  }
  assert.ok(progress.includes('push complete'));
  assert.deepEqual(spawnedServers, ['srv-live'], 'the adopted pty is surfaced, not a new one');
});

test('an attached push whose terminal is lost fails the step instead of reporting success', async () => {
  const run = pushStepRun();
  const holder: { fire?: () => void } = {};
  let lost = false;
  const deps = attachDeps({
    getPushRun: () => ({ id: 'push_1_aa', status: lost ? 'done' : 'running', lost }) as PushRun,
  }, holder);
  const step = runPushStep({ projectPath: '/project' } as Workflow, run, 0, 'http://x', deps);
  for (let i = 0; i < 50 && !holder.fire; i++) await new Promise((r) => setImmediate(r));
  lost = true;
  holder.fire!();
  await assert.rejects(step, /exited without reporting completion/);
});

test('a re-dispatched Push step whose push already FINISHED (its /done beat the re-dispatch) completes without pushing again', async () => {
  const run = pushStepRun();
  const progress: string[] = [];
  const forgotten: string[] = [];
  const unsub = subscribe((ev: WorkflowRunEvent) => {
    if (ev.type === 'step-control-progress' && ev.message) progress.push(ev.message);
  });
  try {
    await runPushStep({ projectPath: '/project' } as Workflow, run, 0, 'http://x', attachDeps({
      findCompletedPushRun: () => ({ id: 'push_1_aa' }),
      findLivePushSession: () => undefined,
      forgetPushRun: (id) => void forgotten.push(id),
    }, {}));
  } finally {
    unsub();
  }
  assert.ok(progress.includes('push complete'));
  assert.deepEqual(forgotten, ['push_1_aa']);
});

test('a push restored as lost whose real /done then arrives is completed, not lost', async () => {
  const { markPushRunCompleted, restorePushRun, getPushRun, forgetPushRun } = await import('../pushRuns.js');
  const id = 'push_1700000000000_abcdef';
  restorePushRun({ id, projectPath: '/project-lost', cwd: '/scratch', status: 'running', startedAt: 1, lost: true } as unknown as PushRun);
  assert.equal(markPushRunCompleted(id), true);
  assert.equal(getPushRun(id)?.status, 'done');
  assert.equal(getPushRun(id)?.lost, false, 'the push succeeded — a re-dispatched Push step must not redo it');
  forgetPushRun(id);
});
