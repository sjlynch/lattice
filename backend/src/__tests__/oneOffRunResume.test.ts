import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import {
  createOneOffRunStore,
  ONE_OFF_RUNS_FILE_VERSION,
  type OneOffRunStore,
} from '../homeScratch/persistence.js';
import { createTask, getTask, updateTask } from '../tasks.js';
import {
  findRunningPushRunForWorkflowStep,
  forgetPushRun,
  getPushRun,
  markPushRunDone,
  pushRunStore,
  recordPushRun,
  type PushRun,
  type StartedPushSession,
} from '../pushRuns.js';
import { deserializePushRun } from '../pushRuns/registry.js';
import { pushPaths } from '../pushRuns/paths.js';
import {
  forgetQaRun,
  getQaRun,
  markQaRunDone,
  qaRunStore,
  recordQaRun,
  recordQaVerdict,
  type QaRun,
} from '../qaRuns.js';
import { qaPaths } from '../qaRuns/paths.js';
import {
  finishPostMergeHook,
  getActiveHookForProject,
  postMergeHookStore,
  type PostMergeHookRun,
} from '../postMergeHooks.js';
import { recordPostMergeHook } from '../postMergeHooks/registry.js';
import { postMergeHookPaths } from '../postMergeHooks/paths.js';
import {
  agentQuiescence,
  forgetAgentQuiescence,
  isAgentQuiescent,
  markAgentReadopted,
  noteAgentSignal,
  noteAgentStop,
  READOPTED_SETTLE_MS,
} from '../agentQuiescence.js';
import {
  classifyOneOffRunResume,
  LOST_SETTLE_GRACE_MS,
  resetOneOffRunWatch,
  resumeInterruptedOneOffRuns,
  runOneOffRunWatchTick,
  watchedOneOffRunIds,
} from '../recovery/oneOffRunResume.js';
import type { Watched } from '../recovery/oneOffRunResume/contracts.js';
import { watchOneOffRun } from '../recovery/oneOffRunResume/watch.js';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import { subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { Workflow } from '../workflows.js';

// Regression for "Lattice restarts while it merges into itself, and every
// push / QA / post-merge session that was running is orphaned". Those
// registries lived only in memory while their agents' ptys live in the
// detached terminal-server, so after a restart a still-working agent's
// callback (`/done`, `/verdict`, `/complete`) 404'd, its terminal idled
// forever, a QA pass never promoted its task, a re-dispatched workflow Push
// step spawned a SECOND push, and a resumed merge run could not see the
// still-running post-merge hook. Running records are now mirrored to
// ~/.lattice/per-project/<hash>/{push-runs,qa-runs,post-merge-hooks}.json and
// re-adopted on boot by recovery/oneOffRunResume.ts.
// The watch must restart its loss grace after a live observation, respect
// callbacks arriving during a probe, and serialize probing and settlement.

async function mkProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-oneoff-resume-'));
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

// ---------- the mirrors ----------

test('push-run mirror: a running run is persisted with its workflow owner and dropped once done', async () => {
  const project = await mkProject();
  const id = pushPaths.createSessionId();
  try {
    recordPushRun({
      id,
      projectPath: project,
      cwd: pushPaths.sessionDir(project, id),
      status: 'running',
      createdAt: 5,
      serverId: 'srv-1',
      workflowRunId: 'wfrun_mirror',
      workflowStepIndex: 2,
    });
    await pushRunStore.flush(project);
    const loaded = await pushRunStore.load(project);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, id);
    assert.equal(loaded[0].serverId, 'srv-1');
    assert.equal(loaded[0].workflowRunId, 'wfrun_mirror');
    assert.equal(loaded[0].workflowStepIndex, 2);

    markPushRunDone(id);
    await pushRunStore.flush(project);
    assert.deepEqual(await pushRunStore.load(project), []);
    assert.equal(await exists(pushRunStore.file(project)), false, 'nothing running ⇒ no file');
  } finally {
    forgetPushRun(id);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('push-run mirror: untrusted records are re-validated (id guard, status, cwd re-derived)', () => {
  // A sibling of the isolated home (os.tmpdir() itself CONTAINS it, which the
  // path guard rightly refuses as "scratch inside the project").
  const project = canonicalProjectPath(path.join(os.tmpdir(), 'lattice-oneoff-deserialize'));
  const id = pushPaths.createSessionId();
  assert.equal(deserializePushRun({ id: '../../etc', status: 'running' }, project), null);
  assert.equal(deserializePushRun({ id, status: 'done' }, project), null);
  const run = deserializePushRun(
    { id, status: 'running', cwd: 'C:/somewhere/else', workflowRunId: 'wf', workflowStepIndex: -1 },
    project,
  );
  assert.ok(run);
  // The on-disk cwd is ignored: recovery matches the live pty by it and the
  // cleanup deletes it, so it always comes from the scratch path guard.
  assert.equal(run.cwd, pushPaths.assertSafeSessionPath(project, id));
  assert.equal(run.workflowRunId, undefined, 'an invalid owner step is dropped');
});

test('QA-run mirror keeps the recorded verdict until the run is done', async () => {
  const project = await mkProject();
  const id = qaPaths.createSessionId();
  try {
    recordQaRun({
      id,
      taskId: 'task-1',
      projectPath: project,
      cwd: qaPaths.sessionDir(project, id),
      status: 'running',
      createdAt: 1,
    });
    recordQaVerdict(id, { passed: true, confident: true, receivedAt: 7 });
    await qaRunStore.flush(project);
    const [loaded] = await qaRunStore.load(project);
    assert.deepEqual(loaded.verdict, { passed: true, confident: true, receivedAt: 7 });
    assert.equal(loaded.taskId, 'task-1');

    markQaRunDone(id);
    await qaRunStore.flush(project);
    assert.deepEqual(await qaRunStore.load(project), []);
  } finally {
    forgetQaRun(id);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('post-merge-hook mirror: running hook persisted, dropped when it finishes', async () => {
  const project = await mkProject();
  const id = postMergeHookPaths.createSessionId();
  try {
    recordPostMergeHook({
      id,
      projectPath: project,
      harness: 'claude',
      prompt: 'update the docs',
      cwd: postMergeHookPaths.sessionDir(project, id),
      status: 'running',
      startedAt: 3,
      trigger: 'merge-run',
    });
    await postMergeHookStore.flush(project);
    const [loaded] = await postMergeHookStore.load(project);
    assert.equal(loaded.id, id);
    assert.equal(loaded.prompt, 'update the docs');

    finishPostMergeHook(id, 'completed');
    await postMergeHookStore.flush(project);
    assert.deepEqual(await postMergeHookStore.load(project), []);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

// ---------- the store itself (homeScratch/persistence.ts) ----------
//
// Every mirror above goes through createOneOffRunStore. Its write chain is
// the reason the module exists: a slow "running" write landing after a newer
// removal would resurrect a finished run as `running` on the next boot (a
// re-adopted push pushes twice, a finished QA run is re-attached).

type TestRun = { id: string; status: 'running' };

function deserializeTestRun(raw: unknown): TestRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return typeof r.id === 'string' && r.status === 'running' ? { id: r.id, status: 'running' } : null;
}

function mkTestStore() {
  return createOneOffRunStore<TestRun>({
    fileName: 'test-runs.json',
    logLabel: '[test]',
    deserialize: deserializeTestRun,
  });
}

const running = (id: string): TestRun => ({ id, status: 'running' });

async function readMirror(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// Yield microtasks until `cond` holds — lets a queued write START (its
// `collect` runs) while its fs work is still in flight.
async function untilMicrotask(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await Promise.resolve();
  assert.ok(cond(), 'the queued write never started');
}

async function withStoreProject(fn: (project: string, store: OneOffRunStore<TestRun>) => Promise<void>): Promise<void> {
  const project = await mkProject();
  const store = mkTestStore();
  try {
    await fn(project, store);
  } finally {
    await store.flush();
    await fs.rm(store.file(project), { force: true });
    await fs.rm(project, { recursive: true, force: true });
  }
}

test('one-off store ordering: a removal persisted after a running write always wins, and vice versa', async () => {
  await withStoreProject(async (project, store) => {
    // Same tick.
    store.persist(project, () => [running('r1')]);
    store.persist(project, () => []);
    await store.flush(project);
    assert.equal(await exists(store.file(project)), false, 'a finished run must not be resurrected');
    assert.deepEqual(await store.load(project), []);

    store.persist(project, () => []);
    store.persist(project, () => [running('r2')]);
    await store.flush(project);
    assert.deepEqual(await readMirror(store.file(project)), { version: ONE_OFF_RUNS_FILE_VERSION, runs: [running('r2')] });
    assert.deepEqual(await store.load(project), [running('r2')]);

    // The real race: the removal is persisted while the running write is in flight.
    let started = false;
    store.persist(project, () => {
      started = true;
      return [running('r3')];
    });
    await untilMicrotask(() => started);
    store.persist(project, () => []);
    await store.flush(project);
    assert.equal(await exists(store.file(project)), false);
    assert.deepEqual(await store.load(project), []);

    // ...and the reverse: a new running record persisted during a removal lands.
    started = false;
    store.persist(project, () => {
      started = true;
      return [];
    });
    await untilMicrotask(() => started);
    store.persist(project, () => [running('r4')]);
    await store.flush(project);
    assert.deepEqual(await store.load(project), [running('r4')]);
  });
});

test('one-off store coalescing: a same-tick burst runs only the latest collect, once; an in-flight write does not swallow a later persist', async () => {
  await withStoreProject(async (project, store) => {
    const first = mock.fn(() => [running('a')]);
    const second = mock.fn(() => [running('b')]);
    const last = mock.fn(() => [running('c')]);
    store.persist(project, first);
    store.persist(project, second);
    store.persist(project, last);
    await store.flush(project);
    assert.equal(first.mock.callCount(), 0, 'superseded collects are never invoked');
    assert.equal(second.mock.callCount(), 0);
    assert.equal(last.mock.callCount(), 1);
    assert.deepEqual(await store.load(project), [running('c')]);

    // `collect` runs at write START, not at persist time: state changed
    // between persist() and the write is what lands.
    let state: TestRun[] = [running('stale')];
    store.persist(project, () => state);
    state = [running('fresh')];
    await store.flush(project);
    assert.deepEqual(await store.load(project), [running('fresh')]);

    // A persist issued while a write is in flight gets its own, later write.
    const inFlight = mock.fn(() => [running('d')]);
    const after = mock.fn(() => [running('e')]);
    store.persist(project, inFlight);
    await untilMicrotask(() => inFlight.mock.callCount() === 1);
    store.persist(project, after);
    await store.flush(project);
    assert.equal(inFlight.mock.callCount(), 1);
    assert.equal(after.mock.callCount(), 1, 'the persist behind an in-flight write must not be dropped');
    assert.deepEqual(await store.load(project), [running('e')]);
  });
});

test('one-off store: a throwing collect is logged and skipped without poisoning the chain', async () => {
  const errorSpy = mock.method(console, 'error', () => undefined);
  try {
    await withStoreProject(async (project, store) => {
      store.persist(project, () => [running('kept')]);
      await store.flush(project);

      store.persist(project, () => {
        throw new Error('collect boom');
      });
      await store.flush(project);
      assert.ok(
        errorSpy.mock.calls.some((c) => String(c.arguments[0]).includes('[test]') && String(c.arguments[1]).includes('collect boom')),
        'the failure is logged under the store label',
      );
      assert.deepEqual(await store.load(project), [running('kept')], 'a failed collect leaves the mirror untouched');

      store.persist(project, () => [running('next')]);
      await store.flush(project);
      assert.deepEqual(await store.load(project), [running('next')]);

      // Same while the throwing write is still queued behind an in-flight one.
      let started = false;
      store.persist(project, () => {
        started = true;
        return [running('x')];
      });
      await untilMicrotask(() => started);
      store.persist(project, () => {
        throw new Error('collect boom 2');
      });
      await store.flush(project);
      store.persist(project, () => []);
      await store.flush(project);
      assert.equal(await exists(store.file(project)), false);
    });
  } finally {
    errorSpy.mock.restore();
  }
});

test('one-off store load(): missing / corrupt / shapeless files read as []; legacy arrays and valid siblings survive', async () => {
  const errorSpy = mock.method(console, 'error', () => undefined);
  try {
    await withStoreProject(async (project, store) => {
      const file = store.file(project);
      assert.deepEqual(await store.load(project), [], 'missing file');
      await fs.mkdir(path.dirname(file), { recursive: true });

      for (const body of ['{ not json', '', '{"version":1}', '{"version":1,"runs":{"id":"r"}}', 'null', '42', '"runs"']) {
        await fs.writeFile(file, body, 'utf8');
        assert.deepEqual(await store.load(project), [], `body ${JSON.stringify(body)}`);
      }

      // Legacy bare array.
      await fs.writeFile(file, JSON.stringify([running('legacy')]), 'utf8');
      assert.deepEqual(await store.load(project), [running('legacy')]);

      // Records the deserializer rejects are dropped; their siblings are kept.
      await fs.writeFile(file, JSON.stringify({
        version: ONE_OFF_RUNS_FILE_VERSION,
        runs: [running('ok1'), { id: 'finished', status: 'done' }, null, 'junk', { status: 'running' }, running('ok2')],
      }), 'utf8');
      assert.deepEqual(await store.load(project), [running('ok1'), running('ok2')]);
    });
  } finally {
    errorSpy.mock.restore();
  }
});

test('one-off store: writes for two projects interleave without either losing its latest state', async () => {
  const projectA = await mkProject();
  const projectB = await mkProject();
  const store = mkTestStore();
  try {
    assert.notEqual(store.file(projectA), store.file(projectB));
    store.persist(projectA, () => [running('a1')]);
    store.persist(projectB, () => [running('b1')]);
    store.persist(projectA, () => []);
    store.persist(projectB, () => [running('b2')]);
    await store.flush();
    assert.equal(await exists(store.file(projectA)), false);
    assert.deepEqual(await store.load(projectB), [running('b2')]);

    // With both writes in flight, each project's follow-up still lands on its own file.
    let aStarted = false;
    let bStarted = false;
    store.persist(projectA, () => {
      aStarted = true;
      return [running('a2')];
    });
    store.persist(projectB, () => {
      bStarted = true;
      return [];
    });
    await untilMicrotask(() => aStarted && bStarted);
    store.persist(projectB, () => [running('b3')]);
    store.persist(projectA, () => [running('a3'), running('a4')]);
    await store.flush();
    assert.deepEqual(await store.load(projectA), [running('a3'), running('a4')]);
    assert.deepEqual(await store.load(projectB), [running('b3')]);

    // A per-project flush waits for that project's chain.
    store.persist(projectA, () => []);
    await store.flush(projectA);
    assert.equal(await exists(store.file(projectA)), false);
    assert.deepEqual(await store.load(projectB), [running('b3')]);
  } finally {
    await store.flush();
    for (const p of [projectA, projectB]) {
      await fs.rm(store.file(p), { force: true });
      await fs.rm(p, { recursive: true, force: true });
    }
  }
});

// ---------- boot re-adoption ----------

test('classifyOneOffRunResume: only a definitively gone pty is settled; "can\'t tell" re-adopts', () => {
  assert.equal(classifyOneOffRunResume(true), 'readopt');
  assert.equal(classifyOneOffRunResume(null), 'readopt');
  assert.equal(classifyOneOffRunResume(false), 'settle-when-lost');
});

test('boot re-adopts live push / QA / post-merge sessions and settles dead ones after the grace', async () => {
  const project = canonicalProjectPath(await mkProject());
  const task = await createTask(project, 'QA me');
  await updateTask(task.id, { status: 'qa' });

  const pushAlive = pushPaths.createSessionId();
  const pushDead = `${pushPaths.createSessionId()}0`;
  const qaDead = qaPaths.createSessionId();
  const hookAlive = postMergeHookPaths.createSessionId();
  const pushRecord = (id: string, stepIndex: number): PushRun => ({
    id,
    projectPath: project,
    cwd: pushPaths.sessionDir(project, id),
    status: 'running',
    createdAt: 1,
    workflowRunId: 'wfrun_resume',
    workflowStepIndex: stepIndex,
  });
  const qaRecord: QaRun = {
    id: qaDead,
    taskId: task.id,
    projectPath: project,
    cwd: qaPaths.sessionDir(project, qaDead),
    status: 'running',
    // Started after the task landed in QA (its `mergedAt`), like a real run.
    createdAt: Date.now(),
    // Reported before the backend went down; the Stop hook's /done never came.
    verdict: { passed: true, confident: true, receivedAt: 1 },
  };
  const hookRecord: PostMergeHookRun = {
    id: hookAlive,
    projectPath: project,
    harness: 'claude',
    prompt: 'hook',
    cwd: postMergeHookPaths.sessionDir(project, hookAlive),
    status: 'running',
    startedAt: Date.now(),
    trigger: 'merge-run',
    serverId: 'stale-server-id',
  };
  // What a previous backend process left on disk.
  pushRunStore.persist(project, () => [pushRecord(pushAlive, 3), pushRecord(pushDead, 4)]);
  qaRunStore.persist(project, () => [qaRecord]);
  postMergeHookStore.persist(project, () => [hookRecord]);
  await Promise.all([pushRunStore.flush(project), qaRunStore.flush(project), postMergeHookStore.flush(project)]);

  const sessions = [
    { id: 'srv-push', cwd: pushPaths.sessionDir(project, pushAlive) },
    { id: 'srv-hook', cwd: postMergeHookPaths.sessionDir(project, hookAlive) },
  ];
  const deps = {
    listSessions: async () => sessions,
    forEachProject: async (_label: string, fn: (p: string) => Promise<void>) => fn(project),
    startWatch: false,
  };
  try {
    await resumeInterruptedOneOffRuns({ ...deps, now: () => 1_000 });

    // Live push: callbacks find it again, and a re-dispatched Push step for
    // its workflow step attaches to it.
    assert.equal(getPushRun(pushAlive)?.status, 'running');
    assert.equal(findRunningPushRunForWorkflowStep('wfrun_resume', 3)?.id, pushAlive);
    // Dead push: tracked (a replayed /done would still land) but not attachable.
    assert.equal(getPushRun(pushDead)?.status, 'running');
    assert.equal(getPushRun(pushDead)?.lost, true);
    assert.equal(findRunningPushRunForWorkflowStep('wfrun_resume', 4), undefined);
    // Live hook: the one-running-per-project state is back (a resumed merge
    // run / Phase C await it instead of starting a second), pointed at the pty
    // actually found, with its subagent state marked unknown.
    const active = getActiveHookForProject(project);
    assert.equal(active?.id, hookAlive);
    assert.equal(active?.serverId, 'srv-hook');
    assert.equal(agentQuiescence(`pmh:${hookAlive}`).readopted, true);
    assert.equal(getQaRun(qaDead)?.status, 'running');
    assert.equal(watchedOneOffRunIds().length, 4);

    // Inside the grace window (the callback outbox may still replay a Stop
    // that fired while the backend was down) nothing is settled.
    await runOneOffRunWatchTick({ listSessions: async () => sessions, now: () => 1_000 + LOST_SETTLE_GRACE_MS - 1 });
    assert.equal(getPushRun(pushDead)?.status, 'running');
    assert.equal(getQaRun(qaDead)?.status, 'running');

    await runOneOffRunWatchTick({ listSessions: async () => sessions, now: () => 1_000 + LOST_SETTLE_GRACE_MS });
    assert.equal(getPushRun(pushDead)?.status, 'done');
    assert.equal(getQaRun(qaDead)?.status, 'done');
    // The QA verdict it reported before the restart still promotes the task.
    assert.equal((await getTask(task.id))?.status, 'done');
    // Live sessions are untouched.
    assert.equal(getPushRun(pushAlive)?.status, 'running');
    assert.equal(getActiveHookForProject(project)?.id, hookAlive);

    // A second boot pass never clobbers a record already tracked.
    await resumeInterruptedOneOffRuns({ ...deps, now: () => 2_000 });
    assert.equal(getPushRun(pushDead)?.status, 'done');
  } finally {
    finishPostMergeHook(hookAlive, 'completed');
    forgetAgentQuiescence(`pmh:${hookAlive}`);
    for (const id of [pushAlive, pushDead]) {
      markPushRunDone(id);
      forgetPushRun(id);
    }
    forgetQaRun(qaDead);
    resetOneOffRunWatch();
    await Promise.all([pushRunStore.flush(project), qaRunStore.flush(project), postMergeHookStore.flush(project)]);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('an unreachable terminal-server re-adopts everything and the watch never settles on "can\'t tell"', async () => {
  const project = canonicalProjectPath(await mkProject());
  const id = pushPaths.createSessionId();
  pushRunStore.persist(project, () => [{
    id,
    projectPath: project,
    cwd: pushPaths.sessionDir(project, id),
    status: 'running',
    createdAt: 1,
  }]);
  await pushRunStore.flush(project);
  try {
    await resumeInterruptedOneOffRuns({
      listSessions: async () => null,
      forEachProject: async (_label, fn) => fn(project),
      startWatch: false,
      now: () => 0,
    });
    assert.equal(getPushRun(id)?.status, 'running');
    assert.equal(getPushRun(id)?.lost, undefined);
    await runOneOffRunWatchTick({ listSessions: async () => null, now: () => 10 * LOST_SETTLE_GRACE_MS });
    assert.equal(getPushRun(id)?.status, 'running');
  } finally {
    markPushRunDone(id);
    forgetPushRun(id);
    resetOneOffRunWatch();
    await pushRunStore.flush(project);
    await fs.rm(project, { recursive: true, force: true });
  }
});

// ---------- one-off liveness watch ----------

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function watchedRun(id: string, overrides: Partial<Watched> = {}): Watched {
  return {
    kind: 'push',
    noun: 'push run',
    run: { id, projectPath: '/project', cwd: `/scratch/${id}` },
    isRunning: () => true,
    settleLost: async () => undefined,
    reason: 'terminal did not survive a backend restart',
    ...overrides,
  };
}

test('one-off watch: a live observation resets the full grace for a later loss', async (t) => {
  resetOneOffRunWatch();
  t.after(resetOneOffRunWatch);
  const settleLost = mock.fn(async (_reason: string) => undefined);
  const entry = watchedRun('grace-reset', { settleLost });
  const liveSessions = [{ id: 'srv-live', cwd: entry.run.cwd }];
  let now = 1_000;
  let sessions = liveSessions;
  const deps = { now: () => now, listSessions: async () => sessions };
  watchOneOffRun(entry);

  await runOneOffRunWatchTick(deps);
  assert.deepEqual(watchedOneOffRunIds(), ['push:grace-reset']);
  assert.equal(entry.goneSince, undefined);
  assert.equal(settleLost.mock.callCount(), 0);

  const firstLoss = now + 1_000;
  now = firstLoss;
  sessions = [];
  await runOneOffRunWatchTick(deps);
  assert.equal(entry.goneSince, firstLoss);
  assert.equal(settleLost.mock.callCount(), 0);

  now = firstLoss + LOST_SETTLE_GRACE_MS - 2;
  sessions = liveSessions;
  await runOneOffRunWatchTick(deps);
  assert.equal(entry.goneSince, undefined, 'seeing the live pty clears the first loss');
  assert.equal(settleLost.mock.callCount(), 0);

  const secondLoss = now + 1;
  now = secondLoss;
  sessions = [];
  await runOneOffRunWatchTick(deps);
  assert.equal(entry.goneSince, secondLoss);
  assert.equal(settleLost.mock.callCount(), 0);

  now = firstLoss + LOST_SETTLE_GRACE_MS;
  await runOneOffRunWatchTick(deps);
  assert.equal(settleLost.mock.callCount(), 0, 'the original deadline cannot settle the later loss');
  assert.deepEqual(watchedOneOffRunIds(), ['push:grace-reset']);

  now = secondLoss + LOST_SETTLE_GRACE_MS - 1;
  await runOneOffRunWatchTick(deps);
  assert.equal(settleLost.mock.callCount(), 0, 'the second loss gets the entire grace window');
  assert.deepEqual(watchedOneOffRunIds(), ['push:grace-reset']);

  now += 1;
  await runOneOffRunWatchTick(deps);
  assert.equal(settleLost.mock.callCount(), 1);
  assert.deepEqual(settleLost.mock.calls[0].arguments, ['terminal exited without calling back']);
  assert.deepEqual(watchedOneOffRunIds(), []);

  for (const later of [now + 1, now + LOST_SETTLE_GRACE_MS]) {
    now = later;
    await runOneOffRunWatchTick(deps);
  }
  assert.equal(settleLost.mock.callCount(), 1, 'a settled entry is never settled twice');
});

test('one-off watch: normal completion during a pending probe prevents lost settlement', async (t) => {
  resetOneOffRunWatch();
  t.after(resetOneOffRunWatch);
  const probe = deferred<[]>();
  const listSessions = mock.fn(() => probe.promise);
  const settleLost = mock.fn(async (_reason: string) => undefined);
  let running = true;
  watchOneOffRun(watchedRun('callback-race', {
    isRunning: () => running,
    settleLost,
    goneSince: 1_000,
  }));
  const deps = { listSessions, now: () => 1_000 + LOST_SETTLE_GRACE_MS + 1 };
  const tick = runOneOffRunWatchTick(deps);
  try {
    assert.equal(listSessions.mock.callCount(), 1, 'the probe is in flight');
    assert.deepEqual(watchedOneOffRunIds(), ['push:callback-race']);
    assert.equal(settleLost.mock.callCount(), 0);

    // Its normal completion callback wins while the terminal probe is pending.
    running = false;
    probe.resolve([]);
    await tick;
    assert.deepEqual(watchedOneOffRunIds(), []);
    assert.equal(settleLost.mock.callCount(), 0);

    await runOneOffRunWatchTick(deps);
    assert.equal(listSessions.mock.callCount(), 1, 'the completed entry was removed from the watch');
    assert.equal(settleLost.mock.callCount(), 0, 'normal completion must not be overwritten or cleaned up twice');
  } finally {
    probe.resolve([]);
    await tick;
  }
});

test('one-off watch: overlapping ticks skip pending probes and settlements, then recover', async (t) => {
  resetOneOffRunWatch();
  t.after(resetOneOffRunWatch);
  const probe = deferred<{ id: string; cwd: string }[]>();
  const settlement = deferred<void>();
  const settlementStarted = deferred<void>();
  const listSessions = mock.fn(() => probe.promise);
  const settleLost = mock.fn(async (_reason: string) => {
    settlementStarted.resolve();
    await settlement.promise;
  });
  const siblingIsRunning = mock.fn(() => true);
  const siblingSettleLost = mock.fn(async (_reason: string) => undefined);
  const sibling = watchedRun('live-sibling', {
    isRunning: siblingIsRunning,
    settleLost: siblingSettleLost,
  });
  const liveSessions = [{ id: 'srv-sibling', cwd: sibling.run.cwd }];
  watchOneOffRun(watchedRun('overlap', { settleLost, goneSince: 1_000 }));
  // Settlement removes its entry before awaiting. Keep a sibling watched so
  // an empty registry cannot hide a broken overlap guard during that await.
  watchOneOffRun(sibling);
  const deps = { listSessions, now: () => 1_000 + LOST_SETTLE_GRACE_MS + 1 };
  const ticks: Promise<void>[] = [];
  const startTick = () => {
    const tick = runOneOffRunWatchTick(deps);
    ticks.push(tick);
    return tick;
  };
  const firstTick = startTick();
  try {
    assert.equal(listSessions.mock.callCount(), 1);
    const duringProbe = startTick();
    assert.equal(listSessions.mock.callCount(), 1, 'an overlapping tick must not start another probe');
    await duringProbe;
    assert.equal(settleLost.mock.callCount(), 0);
    assert.equal(siblingIsRunning.mock.callCount(), 0);

    probe.resolve(liveSessions);
    // A premature return also releases this wait, so it fails an assertion
    // instead of leaving the test hung waiting for settlement to start.
    await Promise.race([settlementStarted.promise, firstTick]);
    assert.equal(settleLost.mock.callCount(), 1);
    assert.deepEqual(watchedOneOffRunIds(), ['push:live-sibling']);

    const duringSettlement = startTick();
    assert.equal(listSessions.mock.callCount(), 1, 'settlement still holds the overlap guard');
    await duringSettlement;
    assert.equal(settleLost.mock.callCount(), 1, 'the pending settlement must not be duplicated');
    assert.equal(siblingIsRunning.mock.callCount(), 0, 'no sibling work starts while settlement is pending');

    settlement.resolve();
    await firstTick;
    assert.equal(siblingIsRunning.mock.callCount(), 1);

    const laterSettleLost = mock.fn(async (_reason: string) => undefined);
    watchOneOffRun(watchedRun('after-overlap', { settleLost: laterSettleLost, goneSince: 1_000 }));
    await startTick();
    assert.equal(listSessions.mock.callCount(), 2, 'finishing settlement releases the guard for later ticks');
    assert.equal(laterSettleLost.mock.callCount(), 1, 'a new overdue entry can settle');
    assert.equal(settleLost.mock.callCount(), 1);
    assert.equal(siblingIsRunning.mock.callCount(), 2);
    assert.equal(siblingSettleLost.mock.callCount(), 0);
    assert.deepEqual(watchedOneOffRunIds(), ['push:live-sibling']);
  } finally {
    probe.resolve(liveSessions);
    settlementStarted.resolve();
    settlement.resolve();
    await Promise.all(ticks);
  }
});

// ---------- workflow Push step re-dispatch ----------

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

// ---------- quiescence after re-adopt ----------

test('a re-adopted session needs the longer settle window before a Stop may finish it', () => {
  mock.timers.enable({ apis: ['Date'] });
  const normal = 'wf:quiesce-normal:0';
  const readopted = 'wf:quiesce-readopted:0';
  try {
    noteAgentSignal(normal);
    markAgentReadopted(readopted);
    noteAgentStop(normal);
    noteAgentStop(readopted);
    mock.timers.tick(5_000);
    assert.equal(isAgentQuiescent(normal, 4_000), true);
    assert.equal(isAgentQuiescent(readopted, 4_000), false, 'pre-restart subagents may still be running');
    mock.timers.tick(READOPTED_SETTLE_MS - 5_000 - 1);
    assert.equal(isAgentQuiescent(readopted, 4_000), false);
    // Any hook from the session (e.g. a surviving subagent's tool use) restarts it.
    noteAgentSignal(readopted);
    mock.timers.tick(READOPTED_SETTLE_MS - 1);
    assert.equal(isAgentQuiescent(readopted, 4_000), false);
    mock.timers.tick(1);
    assert.equal(isAgentQuiescent(readopted, 4_000), true);
  } finally {
    forgetAgentQuiescence(normal);
    forgetAgentQuiescence(readopted);
    mock.timers.reset();
  }
});
