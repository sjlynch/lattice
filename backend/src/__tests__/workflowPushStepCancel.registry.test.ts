// A workflow Push step's bookkeeping in the terminal and push-run registries:
// its step-spawned event carries the registry terminalId (fresh and adopted
// sessions), so the push tab auto-closes like every other step's, and a
// finished step forgets its push run, which nothing else ever polls away.
// Each case's regression story is beside it.
// Shared fixtures: helpers/workflowPushStepCancel.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import { subscribe, type WorkflowRunEvent } from '../workflowRuns/state.js';
import { makeRun, makeWorkflow, PROJECT } from './helpers/workflowPushStepCancel.js';

// The push tab never auto-closed while every other step's did: step-spawned
// omitted `terminalId`, so the frontend minted an unregistered duplicate tab
// that the registry's `owner-finished` end (from the /done cleanup) never
// matched. The event must carry the registry record id — from the spawn, or
// looked up by serverId for a session re-adopted after a restart.
test('push step-spawned carries the registry terminalId (fresh and adopted sessions)', async () => {
  const spawnedIds = async (deps: Partial<PushStepDeps>): Promise<Array<string | undefined>> => {
    const ids: Array<string | undefined> = [];
    const unsub = subscribe((ev: WorkflowRunEvent) => {
      if (ev.type === 'step-spawned') ids.push(ev.terminalId);
    });
    try {
      await runPushStep(makeWorkflow(), makeRun(), 0, 'http://localhost', {
        waitForLaneEmpty: async () => undefined,
        subscribePushRuns: () => () => undefined,
        subscribeWorkflowRuns: () => () => undefined,
        startPushSession: async () => ({
          id: 'push_t', serverId: 'srv-t', terminalId: 'term-fresh', command: 'claude', cwd: '/scratch',
        }),
        getPushRun: () =>
          ({ id: 'push_t', projectPath: PROJECT, cwd: '/scratch', status: 'done', createdAt: 1 }) as ReturnType<
            PushStepDeps['getPushRun']
          >,
        proxyKillSession: async () => true,
        ...deps,
      });
    } finally {
      unsub();
    }
    return ids;
  };

  assert.deepEqual(await spawnedIds({}), ['term-fresh']);
  assert.deepEqual(
    await spawnedIds({
      findLivePushSession: () => ({ id: 'push_t', serverId: 'srv-t', command: 'claude', cwd: '/scratch' }),
      findTerminalId: async (_project, serverId) => (serverId === 'srv-t' ? 'term-adopted' : undefined),
    }),
    ['term-adopted'],
  );
});

// Nothing polls a workflow step's push run (the Task Board's poller is what
// DELETEs its own), so the step must forget it or every workflow push stays in
// the in-memory registry for the life of the process.
test('a finished push step forgets its push run', async () => {
  const run = makeRun();
  const forgotten: string[] = [];
  const deps: PushStepDeps = {
    waitForLaneEmpty: async () => undefined,
    subscribePushRuns: () => () => undefined,
    subscribeWorkflowRuns: () => () => undefined,
    startPushSession: async () => ({ id: 'push_f', serverId: 'srv-f', command: 'claude', cwd: '/scratch' }),
    getPushRun: () =>
      ({ id: 'push_f', projectPath: PROJECT, cwd: '/scratch', status: 'done', createdAt: 1 }) as ReturnType<
        PushStepDeps['getPushRun']
      >,
    proxyKillSession: async () => true,
    forgetPushRun: (id) => forgotten.push(id),
  };
  await runPushStep(makeWorkflow(), run, 0, 'http://localhost', deps);
  assert.deepEqual(forgotten, ['push_f']);
});
