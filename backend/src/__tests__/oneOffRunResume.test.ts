import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
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
    createdAt: 1,
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
