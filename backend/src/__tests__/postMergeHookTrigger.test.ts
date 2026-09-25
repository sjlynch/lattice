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
    patched: Partial<PostMergeHookRun>[];
    killed: string[];
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
    patched: [] as Partial<PostMergeHookRun>[],
    killed: [] as string[],
  };

  const deps: TriggerPostMergeHookDeps = {
    getUserSettings: async () => settings,
    getActiveHookForProject: () =>
      currentRun?.status === 'running' ? currentRun : null,
    getPostMergeHook: (id) => (currentRun?.id === id ? currentRun : null),
    killSession: async (serverId) => {
      calls.killed.push(serverId);
      return true;
    },
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
      calls.patched.push(patch);
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

// The run is recorded BEFORE scratch setup and the queued pty spawn, so /abort
// can land while either is in flight. The trigger must then not act on the
// abandoned launch: no pty kept alive, no `progress` (patch) for a finished
// run, no orange node re-added after the abort removed it.
test('an abort while the queued spawn is pending kills the late pty and registers nothing', async () => {
  const { deps, calls } = makeDeps({
    postMergeHookPrompt: 'run the post-merge checks',
  });
  let releaseSpawn: () => void = () => undefined;
  const spawnBlocked = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });
  deps.queuedCreateSession = async (args) => {
    calls.queued.push(args);
    await spawnBlocked;
    return { id: 'server_late' };
  };

  const pending = triggerPostMergeHookWithDeps(
    { projectPath: PROJECT, backendOrigin: ORIGIN, trigger: 'merge-run' },
    deps,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.queued.length, 1, 'the pty spawn is in flight');

  // What the /abort route does to the registry while the spawn is queued.
  deps.finishPostMergeHook(calls.recorded[0].id, 'aborted', 'aborted by user');
  releaseSpawn();
  const outcome = await pending;

  assert.equal(outcome.kind, 'skipped');
  if (outcome.kind !== 'skipped') return;
  assert.equal(outcome.reason, 'aborted');
  assert.deepEqual(calls.killed, ['server_late'], 'the late pty is reclaimed');
  assert.equal(calls.registered.length, 0, 'no presence node after the abort');
  assert.equal(calls.patched.length, 0, 'no progress event for a finished run');
  assert.deepEqual(calls.cleaned, [{ projectPath: PROJECT, id: calls.recorded[0].id }]);
});

test('an abort while scratch setup is pending skips the spawn entirely', async () => {
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
  deps.finishPostMergeHook(calls.recorded[0].id, 'aborted', 'aborted by user');
  releaseSetup();
  const outcome = await pending;

  assert.equal(outcome.kind, 'skipped');
  if (outcome.kind !== 'skipped') return;
  assert.equal(outcome.reason, 'aborted');
  assert.equal(calls.queued.length, 0, 'no pty is requested for an aborted hook');
  assert.equal(calls.registered.length, 0);
  assert.equal(calls.cleaned.length, 1);
});

// "A post-merge hook is owed" (postMergeHooks/owed.ts): a merge that landed
// before a backend restart whose hook never fired must still get it. The
// trigger settles the debt once it has decided — and only then.
test('the trigger settles an owed hook once it decides; a spawn error or an already-running hook keeps it', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { isPostMergeHookOwed, markPostMergeHookOwed } = await import('../postMergeHooks/owed.js');
  const { patchUserSettings } = await import('../userSettings.js');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-owed-'));
  try {
    // Unconfigured project: nothing to owe.
    await markPostMergeHookOwed(project);
    assert.equal(await isPostMergeHookOwed(project), false);

    await patchUserSettings(project, { postMergeHookPrompt: 'run the checks' });
    await markPostMergeHookOwed(project);
    assert.equal(await isPostMergeHookOwed(project), true);

    // A spawn error keeps the debt (retried by the next merge / boot)...
    const failing = makeDeps({ postMergeHookPrompt: 'run the checks' });
    failing.deps.queuedCreateSession = async () => ({ error: 'terminal-server down' });
    const errored = await triggerPostMergeHookWithDeps(
      { projectPath: project, backendOrigin: ORIGIN, trigger: 'merge-run' },
      failing.deps,
    );
    assert.equal(errored.kind, 'error');
    assert.equal(await isPostMergeHookOwed(project), true);

    // ...a started hook settles it.
    const ok = makeDeps({ postMergeHookPrompt: 'run the checks' });
    const started = await triggerPostMergeHookWithDeps(
      { projectPath: project, backendOrigin: ORIGIN, trigger: 'merge-run' },
      ok.deps,
    );
    assert.equal(started.kind, 'started');
    assert.equal(await isPostMergeHookOwed(project), false);

    // A merge lands while that hook is still running: the next trigger reports
    // already-running, and the debt must SURVIVE it — that hook may predate the
    // merge (or be a dead record restored at boot). runPostMergeHookGate waits
    // it out and fires a fresh one. (The merge lands strictly AFTER the hook
    // started — a hook that started at or after the debt covers it.)
    await new Promise((r) => setTimeout(r, 5));
    await markPostMergeHookOwed(project);
    const again = await triggerPostMergeHookWithDeps(
      { projectPath: project, backendOrigin: ORIGIN, trigger: 'merge-run' },
      ok.deps,
    );
    assert.equal(again.kind === 'skipped' && again.reason, 'already-running');
    assert.equal(await isPostMergeHookOwed(project), true);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

// A restart between the hook's pty spawn and the trigger clearing the owed
// marker (or a clear that failed) left boot re-adopting the live hook with the
// marker still set. The next gate got `already-running`, waited it out, saw the
// marker and fired a SECOND hook for the same merges. The marker's `since`
// settles it: a running hook that started at or after the debt IS its hook.
test('the gate treats a re-adopted hook that started after the debt as covering it — exactly one hook', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { isPostMergeHookOwed, markPostMergeHookOwed, readPostMergeHookOwedSince, clearPostMergeHookOwed } =
    await import('../postMergeHooks/owed.js');
  const { patchUserSettings } = await import('../userSettings.js');
  const { runPostMergeHookGate, restorePostMergeHook, finishPostMergeHook, subscribePostMergeHooks } =
    await import('../postMergeHooks.js');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-owed-readopt-'));
  const started: string[] = [];
  const unsub = subscribePostMergeHooks((ev) => {
    if (ev.type === 'started') started.push(ev.run.id);
  });
  try {
    await patchUserSettings(project, { postMergeHookPrompt: 'run the checks' });
    await markPostMergeHookOwed(project); // t0
    const since = await readPostMergeHookOwedSince(project);
    assert.equal(typeof since, 'number');

    // Boot re-adopts the hook that was spawned for that debt (after t0).
    const hookId = `pmh_readopted_${Date.now()}`;
    restorePostMergeHook({
      id: hookId,
      projectPath: project,
      harness: 'claude',
      prompt: 'run the checks',
      cwd: path.join(os.tmpdir(), hookId),
      status: 'running',
      startedAt: (since as number) + 1,
      trigger: 'merge-run',
      serverId: 'srv_readopted',
    });
    started.length = 0;

    const gate = runPostMergeHookGate({ projectPath: project, backendOrigin: ORIGIN, trigger: 'merge-run' }, 10_000);
    setTimeout(() => finishPostMergeHook(hookId, 'completed'), 20);
    const last = await gate;

    assert.equal(last?.id, hookId, 'the gate waited out the re-adopted hook');
    assert.deepEqual(started, [], 'no second hook was fired for the same merges');
    assert.equal(await isPostMergeHookOwed(project), false, 'the debt is settled');
  } finally {
    unsub();
    await clearPostMergeHookOwed(project);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('a running hook that started BEFORE the debt does not settle it', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { isPostMergeHookOwed, markPostMergeHookOwed, readPostMergeHookOwedSince, clearPostMergeHookOwed } =
    await import('../postMergeHooks/owed.js');
  const { patchUserSettings } = await import('../userSettings.js');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-owed-older-'));
  try {
    await patchUserSettings(project, { postMergeHookPrompt: 'run the checks' });
    await markPostMergeHookOwed(project);
    const since = (await readPostMergeHookOwedSince(project)) as number;
    const { deps } = makeDeps({ postMergeHookPrompt: 'run the checks' });
    const older: PostMergeHookRun = {
      id: 'pmh_older',
      projectPath: project,
      harness: 'claude',
      prompt: 'run the checks',
      cwd: '/tmp/pmh_older',
      status: 'running',
      startedAt: since - 1,
      trigger: 'merge-run',
    };
    deps.getActiveHookForProject = () => older;
    const outcome = await triggerPostMergeHookWithDeps(
      { projectPath: project, backendOrigin: ORIGIN, trigger: 'merge-run' },
      deps,
    );
    assert.equal(outcome.kind === 'skipped' && outcome.reason, 'already-running');
    assert.equal(await isPostMergeHookOwed(project), true, 'the older hook may predate these merges');
  } finally {
    await clearPostMergeHookOwed(project);
    await fs.rm(project, { recursive: true, force: true });
  }
});
