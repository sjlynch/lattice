import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triggerPostMergeHookWithDeps,
  type TriggerPostMergeHookDeps,
} from '../postMergeHooks/trigger.js';
import type { UserSettings } from '../userSettings/types.js';
import type { PostMergeHookRun } from '../postMergeHooks/types.js';

const PROJECT = 'C:\\development\\project';
const ORIGIN = 'http://127.0.0.1:5184';

function makeDeps(settings: UserSettings): {
  deps: TriggerPostMergeHookDeps;
  calls: {
    setup: Parameters<TriggerPostMergeHookDeps['setupPostMergeHookSession']>[0][];
    queued: Parameters<TriggerPostMergeHookDeps['queuedCreateSession']>[0][];
    recorded: PostMergeHookRun[];
    registered: Parameters<TriggerPostMergeHookDeps['registerAgentSession']>[0][];
  };
} {
  let currentRun: PostMergeHookRun | null = null;
  const calls = {
    setup: [] as Parameters<
      TriggerPostMergeHookDeps['setupPostMergeHookSession']
    >[0][],
    queued: [] as Parameters<TriggerPostMergeHookDeps['queuedCreateSession']>[0][],
    recorded: [] as PostMergeHookRun[],
    registered: [] as Parameters<
      TriggerPostMergeHookDeps['registerAgentSession']
    >[0][],
  };

  const deps: TriggerPostMergeHookDeps = {
    getUserSettings: async () => settings,
    getActiveHookForProject: () => null,
    setupPostMergeHookSession: async (args) => {
      calls.setup.push(args);
      return {
        id: 'pmh_test',
        cwd: '/tmp/lattice/pmh_test',
        instructionsFile: '/tmp/lattice/pmh_test/POST_MERGE_HOOK.md',
        harness: args.harness,
      };
    },
    recordPostMergeHook: (run) => {
      currentRun = run;
      calls.recorded.push(run);
    },
    queuedCreateSession: async (args) => {
      calls.queued.push(args);
      return { id: 'server_test' };
    },
    finishPostMergeHook: (id, status, error) => {
      if (!currentRun || currentRun.id !== id) return null;
      currentRun = { ...currentRun, status, error };
      return currentRun;
    },
    patchPostMergeHook: (id, patch) => {
      if (!currentRun || currentRun.id !== id) return null;
      currentRun = { ...currentRun, ...patch };
      return currentRun;
    },
    registerAgentSession: (session) => {
      calls.registered.push(session);
    },
  };

  return { deps, calls };
}

test('triggerPostMergeHook skips blank/whitespace prompts without setup or spawn', async () => {
  const { deps, calls } = makeDeps({ postMergeHookPrompt: '  \n\t  ' });

  const outcome = await triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'manual-merge' },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'skipped', reason: 'no-prompt' });
  assert.equal(calls.setup.length, 0);
  assert.equal(calls.queued.length, 0);
  assert.equal(calls.recorded.length, 0);
});

test('triggerPostMergeHook skips an explicitly disabled prompt without setup or spawn', async () => {
  const { deps, calls } = makeDeps({
    postMergeHookPrompt: 'run the post-merge checks',
    postMergeHookEnabled: false,
  });

  const outcome = await triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'merge-run' },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'skipped', reason: 'disabled' });
  assert.equal(calls.setup.length, 0);
  assert.equal(calls.queued.length, 0);
  assert.equal(calls.recorded.length, 0);
});

test('triggerPostMergeHook treats absent postMergeHookEnabled as enabled when a prompt is present', async () => {
  const { deps, calls } = makeDeps({
    postMergeHookPrompt: '  run the post-merge checks  ',
  });

  const outcome = await triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'merge-run' },
    deps,
  );

  assert.equal(outcome.kind, 'started');
  if (outcome.kind !== 'started') return;
  assert.equal(outcome.serverId, 'server_test');
  assert.equal(outcome.run.prompt, 'run the post-merge checks');
  assert.equal(outcome.run.serverId, 'server_test');

  assert.equal(calls.setup.length, 1);
  assert.equal(calls.setup[0].prompt, 'run the post-merge checks');
  assert.equal(calls.queued.length, 1);
  assert.equal(calls.queued[0].kind, 'post-merge-hook');
  assert.equal(calls.recorded.length, 1);
});
