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
//
// This file: boot re-adoption (only a definitively gone pty is settled, after
// the callback-outbox grace; "can't tell" re-adopts) and the longer settle
// window a re-adopted session needs before a Stop may finish it. The mirrors,
// store, liveness watch and Push re-dispatch are the sibling
// oneOffRunResume.*.test.ts files. Shared fixtures: helpers/oneOffRunResume.ts.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { canonicalProjectPath } from '../projectPath.js';
import { createTask, getTask, updateTask } from '../tasks.js';
import {
  findRunningPushRunForWorkflowStep,
  forgetPushRun,
  getPushRun,
  markPushRunDone,
  pushRunStore,
  type PushRun,
} from '../pushRuns.js';
import { pushPaths } from '../pushRuns/paths.js';
import { forgetQaRun, getQaRun, qaRunStore, type QaRun } from '../qaRuns.js';
import { qaPaths } from '../qaRuns/paths.js';
import {
  finishPostMergeHook,
  getActiveHookForProject,
  postMergeHookStore,
  type PostMergeHookRun,
} from '../postMergeHooks.js';
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
import { mkProject } from './helpers/oneOffRunResume.js';

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
