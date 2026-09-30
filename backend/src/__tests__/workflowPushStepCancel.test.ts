import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import { subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { StartedPushSession } from '../pushRuns.js';
import type { Workflow } from '../workflows.js';
import { createHomeScratchPaths } from '../homeScratch/paths.js';
import { createHomeScratchAgentSession } from '../homeScratch/agentSession.js';
import { queuedCreateSession } from '../queuedCreateSession.js';
import { cancelSpawn } from '../spawnQueue.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { drainQueue } from '../spawnQueue/drain.js';
import { withTempDir } from './helpers/tempDir.js';

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
  return { projectPath: PROJECT, steps: [{ kind: 'push' }] } as Workflow;
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
    abandonPushRun: (_projectPath, id) => abandoned.push(id),
  };
  const abandoned: string[] = [];

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
  assert.deepEqual(abandoned, ['push_1'], 'the killed push run is settled');
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

// A session the step killed never reaches its Stop hook, so the push run used
// to stay `running` in the registry forever, its orange graph node lingered for
// the 30-min silence sweep, and its scratch dir waited for the next boot.
test('a cancel after the push session spawned kills it and settles the push run', async () => {
  const run = makeRun();
  const holder = { cancel: undefined as ((ev: WorkflowRunEvent) => void) | undefined };
  const killed: string[] = [];
  const abandoned: Array<[string, string]> = [];
  let spawned = false;
  const deps: PushStepDeps = {
    waitForLaneEmpty: async () => undefined,
    subscribePushRuns: () => () => undefined,
    subscribeWorkflowRuns: (cb) => {
      holder.cancel = cb;
      return () => undefined;
    },
    startPushSession: async () => {
      spawned = true;
      return { id: 'push_live', serverId: 'srv-live', command: 'claude', cwd: '/scratch' };
    },
    getPushRun: () =>
      ({ id: 'push_live', projectPath: PROJECT, cwd: '/scratch', status: 'running', createdAt: 1 }) as ReturnType<
        PushStepDeps['getPushRun']
      >,
    proxyKillSession: async (serverId: string) => {
      killed.push(serverId);
      return true;
    },
    abandonPushRun: (projectPath, id) => abandoned.push([projectPath, id]),
  };
  const stepPromise = runPushStep(makeWorkflow(), run, 0, 'http://localhost', deps);
  await waitFor(() => spawned);
  // Let the post-spawn code reach `await done`.
  await new Promise((resolve) => setImmediate(resolve));
  run.status = 'cancelled';
  holder.cancel!({ type: 'cancelled', run });
  await stepPromise;
  assert.deepEqual(killed, ['srv-live']);
  assert.deepEqual(abandoned, [[PROJECT, 'push_live']]);
});

test('a push whose own /done already landed is not abandoned by a later cancel', async () => {
  const run = makeRun();
  const abandoned: string[] = [];
  const deps: PushStepDeps = {
    waitForLaneEmpty: async () => undefined,
    subscribePushRuns: () => () => undefined,
    subscribeWorkflowRuns: () => () => undefined,
    startPushSession: async () => {
      run.status = 'cancelled';
      return { id: 'push_done', serverId: 'srv-done', command: 'claude', cwd: '/scratch' };
    },
    getPushRun: () =>
      ({ id: 'push_done', projectPath: PROJECT, cwd: '/scratch', status: 'done', createdAt: 1 }) as ReturnType<
        PushStepDeps['getPushRun']
      >,
    proxyKillSession: async () => true,
    abandonPushRun: (_projectPath, id) => abandoned.push(id),
  };
  await runPushStep(makeWorkflow(), run, 0, 'http://localhost', deps);
  assert.deepEqual(abandoned, []);
});

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

// The post-spawn guard cannot settle a Push still waiting for capacity. Use
// the real admission queue with controlled terminal creation and scratch so
// cancellation/timeout must remove the request without any capacity grant.
function resetCapacity(): void {
  queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
  queueState.accounting.reconcile(0, Date.now() + 1);
}

async function awaitWorker<T>(worker: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      worker,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Push worker did not settle')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function queuedPushFixture(
  projectPath: string,
  pushTimeoutMs: number,
  terminals: Parameters<typeof queuedCreateSession>[1],
) {
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  const paths = createHomeScratchPaths({
    dirName: 'push-admission-test', idPrefix: 'push', logLabel: '[push-test]', noun: 'push session',
  });
  const id = paths.createSessionId();
  const cwd = paths.assertSafeSessionPath(projectPath, id);
  await fs.mkdir(cwd, { recursive: true });
  const dedupeKey = `push:${id}`;
  const cleaned: string[] = [];
  const holder = { cancel: undefined as ((ev: WorkflowRunEvent) => void) | undefined };
  const deps: PushStepDeps = {
    pushTimeoutMs,
    waitForLaneEmpty: async () => undefined,
    subscribePushRuns: () => () => undefined,
    subscribeWorkflowRuns: (cb) => {
      holder.cancel = cb;
      return () => { holder.cancel = undefined; };
    },
    startPushSession: async (_project, _origin, opts) => {
      try {
        const session = await queuedCreateSession({
          kind: 'push-run', priority: 'interactive', dedupeKey, opts: { cwd }, signal: opts?.signal,
        }, terminals);
        if ('error' in session) throw new Error(session.error);
        return { id, cwd, serverId: session.id, command: 'claude' };
      } catch (err) {
        await fs.rm(paths.assertSafeSessionPath(projectPath, id), { recursive: true, force: true });
        cleaned.push(id);
        throw err;
      }
    },
    getPushRun: () => undefined,
    proxyKillSession: async () => assert.fail('the queue must reclaim an undelivered PTY'),
    abandonPushRun: () => assert.fail('an unstarted push has no run to abandon'),
  };
  return { id, cwd, dedupeKey, cleaned, holder, deps };
}

test('the scratch agent adapters forward an aborted admission signal and clean setup without spawning', async () => {
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  await withTempDir('lattice-push-signal-', async (projectPath) => {
    const paths = createHomeScratchPaths({
      dirName: 'push-signal-test', idPrefix: 'push', logLabel: '[push-test]', noun: 'push session',
    });
    const id = paths.createSessionId();
    const cwd = paths.assertSafeSessionPath(projectPath, id);
    const cleaned: string[] = [];
    const start = createHomeScratchAgentSession({
      paths: { ...paths, createSessionId: () => id },
      instructionsFileName: 'BRIEF.md',
      command: 'unused',
      queueKind: 'push-run',
      dedupeKeyPrefix: 'push',
      agentId: (sessionId) => `push:${sessionId}`,
      presenceLabel: 'push',
      cleanup: async (project, sessionId) => {
        await fs.rm(paths.assertSafeSessionPath(project, sessionId), { recursive: true, force: true });
        cleaned.push(sessionId);
      },
    });
    // With capacity blocked, a dropped signal would leave startup pending.
    queueState.accounting.setSoftCap(1);
    queueState.accounting.reconcile(1 + SPAWN_QUEUE_CONFIG.priorityReserve, Date.now() + 1);
    const controller = new AbortController();
    const cancelled = new Error('push cancelled before admission');
    controller.abort(cancelled);
    const started = start({
      projectPath,
      signal: controller.signal,
      installHooks: async () => undefined,
      renderInstructions: () => 'unused',
      recordRun: () => assert.fail('an aborted admission must not record a live run'),
    });
    try {
      await assert.rejects(awaitWorker(started), (err: unknown) => err === cancelled);
      assert.equal(queueState.get(`push:${id}`), undefined);
      assert.deepEqual(cleaned, [id]);
      await assert.rejects(fs.access(cwd), { code: 'ENOENT' });
    } finally {
      cancelSpawn(`push:${id}`);
      await started.catch(() => undefined);
      resetCapacity();
    }
  });
});

for (const reason of ['cancel', 'timeout'] as const) {
  test(`a capacity-blocked Push ${reason} withdraws admission, cleans scratch and releases its lock without capacity`, async () => {
    await withTempDir('lattice-push-admission-', async (projectPath) => {
      let created = 0;
      const fixture = await queuedPushFixture(projectPath, reason === 'timeout' ? 20 : 60_000, {
        proxyCreateSession: async () => { created += 1; return { id: 'must-not-spawn' }; },
        proxyKillSession: async () => assert.fail('a queued request has no PTY'),
      });
      queueState.accounting.setSoftCap(1);
      queueState.accounting.reconcile(1 + SPAWN_QUEUE_CONFIG.priorityReserve, Date.now() + 1);
      const run = { ...makeRun(), projectPath };
      const wf = { projectPath, steps: [{ kind: 'push' }] } as Workflow;
      let released = 0;
      let advanced = 0;
      const progress: string[] = [];
      let stepSpawned = false;
      const unsub = subscribe((ev) => {
        if (ev.type === 'step-control-progress' && ev.message) progress.push(ev.message);
        if (ev.type === 'step-spawned') stepSpawned = true;
      });
      const worker = runControlStepWorker(wf, run, 0, 'http://localhost', async () => { advanced += 1; }, {
        acquireLock: async () => ({ release: async () => {
          assert.deepEqual(fixture.cleaned, [fixture.id], 'scratch cleanup precedes lock release');
          released += 1;
        } }),
        waitForRepoMaintenance: async () => true,
        runStart: async () => undefined,
        runMerge: async () => undefined,
        runPush: (w, r, i, origin) => runPushStep(w, r, i, origin, fixture.deps),
      });
      try {
        await waitFor(() => !!queueState.get(fixture.dedupeKey));
        assert.equal(queueState.get(fixture.dedupeKey)?.state, 'pending');
        if (reason === 'cancel') {
          run.status = 'cancelled';
          fixture.holder.cancel!({ type: 'cancelled', run });
        }
        await awaitWorker(worker);
        assert.equal(queueState.get(fixture.dedupeKey), undefined, 'admission is withdrawn');
        assert.equal(queueState.accounting.getLiveCount(), 1 + SPAWN_QUEUE_CONFIG.priorityReserve);
        assert.equal(run.status, reason === 'cancel' ? 'cancelled' : 'errored');
        if (reason === 'timeout') assert.match(run.error ?? '', /push step timed out after 20ms/);
        else assert.equal(run.error, undefined);
        assert.equal(released, 1);
        assert.equal(advanced, 0);
        assert.equal(run.currentStepIndex, 0);
        assert.equal(stepSpawned, false);
        assert.ok(!progress.includes('push complete'));
        assert.deepEqual(fixture.cleaned, [fixture.id]);
        await assert.rejects(fs.access(fixture.cwd), { code: 'ENOENT' });
        resetCapacity();
        drainQueue();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(created, 0, 'capacity returning must not launch the cancelled admission');
      } finally {
        run.status = 'cancelled';
        cancelSpawn(fixture.dedupeKey);
        await worker;
        unsub();
        resetCapacity();
      }
    });
  });

  test(`a Push ${reason} during PTY creation retains its lock until the late PTY is reclaimed`, async () => {
    await withTempDir('lattice-push-in-flight-', async (projectPath) => {
      let resolveCreate!: (session: { id: string }) => void;
      let resolveKill!: (confirmed: boolean) => void;
      const creation = new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; });
      const killing = new Promise<boolean>((resolve) => { resolveKill = resolve; });
      const killed: string[] = [];
      let creating = false;
      const fixture = await queuedPushFixture(projectPath, reason === 'timeout' ? 20 : 60_000, {
        proxyCreateSession: () => { creating = true; return creation; },
        proxyKillSession: (id) => { killed.push(id); return killing; },
      });
      resetCapacity();
      const run = { ...makeRun(), projectPath };
      const wf = { projectPath, steps: [{ kind: 'push' }] } as Workflow;
      let released = 0;
      let advanced = 0;
      const worker = runControlStepWorker(wf, run, 0, 'http://localhost', async () => { advanced += 1; }, {
        acquireLock: async () => ({ release: async () => { released += 1; } }),
        waitForRepoMaintenance: async () => true,
        runStart: async () => undefined,
        runMerge: async () => undefined,
        runPush: (w, r, i, origin) => runPushStep(w, r, i, origin, fixture.deps),
      });
      try {
        await waitFor(() => creating);
        if (reason === 'cancel') {
          run.status = 'cancelled';
          fixture.holder.cancel!({ type: 'cancelled', run });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(queueState.get(fixture.dedupeKey)?.signal.aborted, true);
        assert.equal(released, 0, 'creation is still owned by the worker');
        assert.deepEqual(fixture.cleaned, []);
        resolveCreate({ id: 'late-push-pty' });
        await waitFor(() => killed.length > 0);
        assert.deepEqual(killed, ['late-push-pty']);
        assert.equal(released, 0, 'an unconfirmed kill must retain ownership');
        assert.deepEqual(fixture.cleaned, []);
        resolveKill(true);
        await awaitWorker(worker);
        assert.equal(released, 1);
        assert.equal(advanced, 0);
        assert.equal(run.status, reason === 'cancel' ? 'cancelled' : 'errored');
        if (reason === 'timeout') assert.match(run.error ?? '', /push step timed out after 20ms/);
        assert.equal(queueState.get(fixture.dedupeKey), undefined);
        assert.deepEqual(fixture.cleaned, [fixture.id]);
        await assert.rejects(fs.access(fixture.cwd), { code: 'ENOENT' });
      } finally {
        run.status = 'cancelled';
        cancelSpawn(fixture.dedupeKey);
        resolveCreate({ id: 'late-push-pty' });
        resolveKill(true);
        await worker;
        resetCapacity();
      }
    });
  });
}
