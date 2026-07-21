import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triggerPostMergeHookWithDeps,
  type TriggerPostMergeHookDeps,
} from '../postMergeHooks/trigger.js';
import { hasPendingPostMergeHookTrigger } from '../postMergeHooks/registry.js';
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
    cleaned: { projectPath: string; id: string }[];
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
    cleaned: [] as { projectPath: string; id: string }[],
  };

  const deps: TriggerPostMergeHookDeps = {
    getUserSettings: async () => settings,
    getActiveHookForProject: () =>
      currentRun?.status === 'running' ? currentRun : null,
    setupPostMergeHookSession: async (args) => {
      calls.setup.push(args);
      return {
        id: args.id,
        cwd: `/tmp/lattice/${args.id}`,
        instructionsFile: `/tmp/lattice/${args.id}/POST_MERGE_HOOK.md`,
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
    cleanupPostMergeHookSession: async (projectPath, id) => {
      calls.cleaned.push({ projectPath, id });
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
  assert.equal(calls.cleaned.length, 0);
});

test('triggerPostMergeHook cleans pmh scratch when queued spawn fails', async () => {
  const { deps, calls } = makeDeps({
    postMergeHookPrompt: 'run the post-merge checks',
  });
  deps.queuedCreateSession = async (args) => {
    calls.queued.push(args);
    return { error: 'spawn queue rejected' };
  };

  const outcome = await triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'manual-merge' },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'error', message: 'spawn queue rejected' });
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.cleaned.length, 1);
  assert.deepEqual(calls.cleaned[0], {
    projectPath: PROJECT,
    id: calls.recorded[0].id,
  });
});

test('triggerPostMergeHook finishes and cleans an early record when scratch setup fails', async () => {
  const { deps, calls } = makeDeps({
    postMergeHookPrompt: 'run the post-merge checks',
  });
  deps.setupPostMergeHookSession = async (args) => {
    calls.setup.push(args);
    throw new Error('scratch setup failed');
  };

  const outcome = await triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'manual-merge' },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'error', message: 'scratch setup failed' });
  assert.equal(calls.recorded.length, 1, 'the launch reservation is visible');
  assert.deepEqual(calls.cleaned, [
    { projectPath: PROJECT, id: calls.recorded[0].id },
  ]);
  assert.equal(calls.queued.length, 0);
});

test('trigger records the hook before asynchronous scratch setup finishes', async () => {
  const { deps, calls } = makeDeps({
    postMergeHookPrompt: 'run the post-merge checks',
  });
  let releaseSetup: () => void = () => undefined;
  const setupBlocked = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  deps.setupPostMergeHookSession = async (args) => {
    calls.setup.push(args);
    await setupBlocked;
    return {
      id: args.id,
      cwd: `/tmp/lattice/${args.id}`,
      instructionsFile: `/tmp/lattice/${args.id}/POST_MERGE_HOOK.md`,
      harness: args.harness,
    };
  };

  const pending = triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'manual-merge' },
    deps,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls.setup.length, 1, 'scratch setup is in flight');
  assert.equal(calls.queued.length, 0, 'pty spawn has not begun');
  assert.equal(calls.recorded.length, 1, 'the gate can already see a running hook');
  assert.equal(calls.recorded[0].status, 'running');

  releaseSetup();
  const outcome = await pending;
  assert.equal(outcome.kind, 'started');
});

test('trigger exposes the pre-record settings-read window to the Merge-step gate', async () => {
  const settings: UserSettings = {
    postMergeHookPrompt: 'run the post-merge checks',
  };
  const { deps } = makeDeps(settings);
  let releaseSettings: () => void = () => undefined;
  const settingsBlocked = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  deps.getUserSettings = async () => {
    await settingsBlocked;
    return settings;
  };

  const pending = triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'manual-merge' },
    deps,
  );
  assert.equal(hasPendingPostMergeHookTrigger(PROJECT), true);

  releaseSettings();
  await pending;
  assert.equal(hasPendingPostMergeHookTrigger(PROJECT), false);
});

test('simultaneous triggers atomically claim one hook for the project', async () => {
  const settings: UserSettings = {
    postMergeHookPrompt: 'run the post-merge checks',
  };
  const { deps, calls } = makeDeps(settings);
  let settingsReads = 0;
  let releaseSettings: () => void = () => undefined;
  const bothReading = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  deps.getUserSettings = async () => {
    settingsReads += 1;
    if (settingsReads === 2) releaseSettings();
    await bothReading;
    return settings;
  };

  const options = {
    projectPath: PROJECT,
    backendOrigin: ORIGIN,
    trigger: 'manual-merge' as const,
  };
  const [first, second] = await Promise.all([
    triggerPostMergeHookWithDeps(options, deps),
    triggerPostMergeHookWithDeps(options, deps),
  ]);

  assert.deepEqual(
    [first.kind, second.kind].sort(),
    ['skipped', 'started'],
    'one trigger starts and the other joins the existing run',
  );
  const skipped = first.kind === 'skipped' ? first : second;
  assert.equal(skipped.kind, 'skipped');
  if (skipped.kind === 'skipped') assert.equal(skipped.reason, 'already-running');
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.setup.length, 1);
  assert.equal(calls.queued.length, 1);
});
