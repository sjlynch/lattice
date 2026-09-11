import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claimRecoveryAttempt, readRecoveryAttempts, recoveryAttemptsFile, resetRecoveryAttempt } from '../recovery/retryBudget.js';
import { startMergeRun, subscribe } from '../mergeRuns.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { resumePersistedRun } from '../recovery/workflowRunResume.js';
import { runs, type WorkflowRun } from '../workflowRuns/state.js';
import { flushWorkflowRunPersist } from '../workflowRuns/persistence.js';
import { canonicalProjectPath } from '../projectPath.js';
import type { Task } from '../tasks.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const project = canonicalProjectPath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-retry-budget-')));
  t.after(async () => { await flushWorkflowRunPersist(project); await fs.rm(project, { recursive: true, force: true }); });
  return project;
}

test('automatic recovery survives reloads and pauses after three attempts at unchanged work', async (t) => {
  const project = await fixture(t);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await claimRecoveryAttempt(project, 'merge', 'task-a|task-b');
    assert.equal(result.attempts, attempt);
    assert.equal(result.paused, undefined);
    assert.equal((await readRecoveryAttempts(project))[0].attempts, attempt);
  }
  assert.match((await claimRecoveryAttempt(project, 'merge', 'task-a|task-b')).paused!, /paused/);
  assert.equal((await claimRecoveryAttempt(project, 'merge', 'task-b')).attempts, 1, 'a merged task is durable progress');
  await resetRecoveryAttempt(project, 'merge');
  assert.deepEqual(await readRecoveryAttempts(project), []);
});

test('concurrent in-process claims cannot each reset the counter to one', async (t) => {
  const project = await fixture(t);
  const result = await Promise.all(Array.from({ length: 6 }, () => claimRecoveryAttempt(project, 'workflow:one', 'step')));
  assert.equal(result.filter((r) => !r.paused).length, 3);
  assert.equal((await readRecoveryAttempts(project))[0].attempts, 3);
});

test('corrupt recovery records are preserved and refuse replay instead of granting a fresh budget', async (t) => {
  const project = await fixture(t);
  await claimRecoveryAttempt(project, 'merge', 'task');
  const file = recoveryAttemptsFile(project);
  await fs.writeFile(file, '{broken');
  await assert.rejects(claimRecoveryAttempt(project, 'merge', 'task'));
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('a paused merge never reaches preflight and releases the acquired project lock; an explicit retry is allowed', async (t) => {
  const project = await fixture(t);
  for (let i = 0; i < 3; i++) await claimRecoveryAttempt(project, 'merge', 'one');
  let preflights = 0;
  const task = { id: 'one', projectPath: project, status: 'ready_to_merge', createdAt: 1 } as Task;
  const deps = { listTasks: async () => [task], runPreflight: async () => { preflights++; throw new Error('test worker halted'); },
    processTarget: async () => 'halt' as const };
  const errors: string[] = [];
  const watchPaused = subscribe((event) => { if (event.type === 'completed' && event.run.projectPath === project) errors.push(...event.run.errored.map((e) => e.error)); });
  try { await assert.rejects(startMergeRun(project, 'http://unused', { automaticRecovery: true }, deps), /paused/); }
  finally { watchPaused(); }
  assert.equal(preflights, 0);
  assert.match(errors[0], /paused/, 'existing merge-run event delivers the pause reason to UI subscribers');
  assert.equal(await inspectProjectRunLock(project), null);
  let finished!: () => void;
  const completion = new Promise<void>((resolve) => { finished = resolve; });
  const unsub = subscribe((event) => { if (event.type === 'completed' && event.run.projectPath === project) finished(); });
  try {
    await startMergeRun(project, 'http://unused', { resetRecoveryBudget: true }, deps);
    await completion;
    assert.equal(preflights, 1);
    assert.deepEqual(await readRecoveryAttempts(project), []);
  } finally { unsub(); }
});

for (const phase of ['pending', 'running'] as const) {
  test(`workflow ${phase} replay budget pauses visibly before redispatch`, async (t) => {
    const project = await fixture(t);
    const run: WorkflowRun = { id: `wfrun-budget-${phase}`, workflowId: 'wf', workflowName: 'Budget', projectPath: project,
      status: 'running', startedAt: 1, currentStepIndex: 0, totalSteps: 1, stepPhase: phase,
      definition: { id: 'wf', name: 'Budget', projectPath: project, createdAt: 1, variables: [],
        steps: [{ id: 'step', title: 'Step', prompt: 'no spawn', mode: 'sequential', harness: 'claude', kind: phase === 'pending' ? 'agent' : 'merge' }] } };
    const checkpoint = JSON.stringify([0, 'step', []]);
    for (let i = 0; i < 3; i++) await claimRecoveryAttempt(project, `workflow:${run.id}`, checkpoint);
    try {
      await resumePersistedRun(run, [], 'http://unused');
      assert.equal(runs.get(run.id)?.status, 'errored');
      assert.match(runs.get(run.id)?.error ?? '', /paused/);
      assert.ok((await readRecoveryAttempts(project))[0].paused);
    } finally { runs.delete(run.id); }
  });
}

test('workflow journal failure becomes a visible error rather than a workerless running record', async (t) => {
  const project = await fixture(t);
  await claimRecoveryAttempt(project, 'any', 'checkpoint');
  await fs.writeFile(recoveryAttemptsFile(project), '{broken');
  const run: WorkflowRun = { id: 'wfrun-journal-failure', workflowId: 'wf', workflowName: 'Budget', projectPath: project,
    status: 'running', startedAt: 1, currentStepIndex: 0, totalSteps: 1, stepPhase: 'pending',
    definition: { id: 'wf', name: 'Budget', projectPath: project, createdAt: 1, variables: [],
      steps: [{ id: 'step', title: 'Step', prompt: 'no spawn', mode: 'sequential', harness: 'claude' }] } };
  try {
    await resumePersistedRun(run, [], 'http://unused');
    assert.equal(runs.get(run.id)?.status, 'errored');
    assert.match(runs.get(run.id)?.error ?? '', /could not record its attempt/);
    assert.equal(await fs.readFile(recoveryAttemptsFile(project), 'utf8'), '{broken');
  } finally { runs.delete(run.id); }
});

for (const failJournal of [false, true]) {
test(`recovery cannot dispatch or error a successor advanced during the retry journal write (failure=${failJournal})`, async (t) => {
  const project = await fixture(t);
  const run: WorkflowRun = { id: 'wfrun-budget-racing-completion', workflowId: 'wf', workflowName: 'Race', projectPath: project,
    status: 'running', startedAt: 1, currentStepIndex: 0, totalSteps: 2, stepPhase: 'running',
    definition: { id: 'wf', name: 'Race', projectPath: project, createdAt: 1, variables: [], steps: [
      { id: 'first', title: 'First', prompt: '', mode: 'sequential', harness: 'claude', kind: 'merge' },
      { id: 'successor', title: 'Successor', prompt: 'must not be dispatched twice', mode: 'sequential', harness: 'claude' },
    ] } };
  runs.set(run.id, run);
  const rename = fs.rename;
  let advanced = false;
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const result = await rename(...args);
    if (String(args[1]) === recoveryAttemptsFile(project)) {
      // Model a completion callback updating the same live registry object
      // while recovery's required write is in flight.
      run.currentStepIndex = 1;
      run.stepPhase = 'pending';
      advanced = true;
      if (failJournal) throw new Error('journal persistence failure after concurrent completion');
    }
    return result;
  });
  try {
    await resumePersistedRun(run, [], 'http://unused', true);
    assert.equal(advanced, true);
    assert.equal(run.status, 'running');
    assert.equal(run.currentStepIndex, 1);
    await assert.rejects(fs.access(workflowStepDir(project, run.id, 1)), { code: 'ENOENT' });
  } finally { mock.mock.restore(); runs.delete(run.id); }
});
}
