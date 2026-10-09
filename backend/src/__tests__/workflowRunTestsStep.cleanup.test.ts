// Run tests step teardown at its boundaries. Cancellation must release even a
// late-acquired lock (once, without capturing WIP or spawning); failed
// finalization — a rejected commit post-check or a rejected run-tests.json
// write — must stop watchers (spawn subscription, timeout) before I/O, retain
// the lock through that I/O, and still permit advancement, releasing the entry,
// checkpoint and lock exactly once. Harness: helpers/workflowRunTestsStep.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cancelWorkflowRun, completeWorkflowStep } from '../workflowRuns.js';
import { runs, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import { createWorkflow } from '../workflows.js';
import {
  abortRunTestsStep,
  finalizeRunTestsStep,
  hasActiveRunTestsStep,
  runRunTestsWorker,
  runTestsLockLabel,
  type RunTestsDeps,
} from '../workflowRuns/testStep/runTestsStep.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import {
  acquireProjectRunLock,
  inspectProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from '../projectRunLock.js';
import { ORIGIN, setup, testStep, waitFor } from './helpers/workflowRunTestsStep.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Register a fresh run without detached dispatch so these boundary tests can
// await the worker itself, including its teardown after late lock delivery.
async function trackedTestRun(project: string): Promise<WorkflowRun> {
  const wf = await createWorkflow(project, 'Run tests cleanup', [testStep({ timeoutMinutes: 5 })]);
  const run: WorkflowRun = {
    id: `wfrun_cleanup_${Math.random().toString(36).slice(2, 8)}`,
    workflowId: wf.id, workflowName: wf.name, projectPath: wf.projectPath,
    status: 'running', startedAt: Date.now(), totalSteps: wf.steps.length,
    currentStepIndex: 0, definition: wf, stepPhase: 'pending',
  };
  runs.set(run.id, run);
  return run;
}

function trackedProjectLock() {
  let handle: ProjectRunLockHandle | undefined;
  let releases = 0;
  const acquireLock: RunTestsDeps['acquireLock'] = async (...args) => {
    const acquired = await acquireProjectRunLock(...args);
    handle = acquired;
    return { release: async () => { releases++; await acquired.release(); } };
  };
  return {
    acquireLock,
    get releases() { return releases; },
    // A failing assertion must not strand a real lock in the isolated HOME.
    cleanup: async () => { if (releases === 0) await handle?.release(); },
  };
}

function controlledRunSubscriptions() {
  const listeners = new Set<(event: WorkflowRunEvent) => void>();
  let added = 0;
  let removed = 0;
  const subscribeRuns: RunTestsDeps['subscribeRuns'] = (listener) => {
    added++;
    listeners.add(listener);
    return () => { removed++; listeners.delete(listener); };
  };
  return {
    subscribeRuns,
    emit: (event: WorkflowRunEvent) => { for (const listener of [...listeners]) listener(event); },
    get added() { return added; },
    get removed() { return removed; },
    get active() { return listeners.size; },
    cleanup: () => { listeners.clear(); },
  };
}

test('cancellation before lock delivery releases the late handle once without capturing WIP or spawning', async () => {
  const delivery = deferred<void>();
  const locks = trackedProjectLock();
  const subscriptions = controlledRunSubscriptions();
  const calls = { head: 0, status: 0, checkpoint: 0, complete: 0 };
  let acquired = false;
  let acquireArgs: Parameters<RunTestsDeps['acquireLock']> | undefined;
  const h = await setup({
    acquireLock: async (...args) => {
      acquireArgs = args;
      const handle = await locks.acquireLock(...args);
      acquired = true;
      await delivery.promise;
      return handle;
    },
    readHead: async () => { calls.head++; return 'aaaaaaa1'; },
    readStatus: async () => { calls.status++; return ['user.ts']; },
    checkpoint: async () => { calls.checkpoint++; },
    subscribeRuns: subscriptions.subscribeRuns,
  });
  let run: WorkflowRun | undefined;
  let worker: Promise<void> | undefined;
  try {
    run = await trackedTestRun(h.project);
    worker = runRunTestsWorker(run.definition!, run, 0, ORIGIN, async (...args) => {
      calls.complete++;
      await completeWorkflowStep(...args);
    });
    await waitFor(() => acquired, 3000, 'lock acquired but not delivered');
    assert.deepEqual(acquireArgs, [run.projectPath, runTestsLockLabel(run.id), { lendable: false }]);
    assert.equal(hasActiveRunTestsStep(run.id), true);
    assert.equal((await inspectProjectRunLock(run.projectPath))?.holder.label, runTestsLockLabel(run.id));

    assert.equal(cancelWorkflowRun(run.id), true);
    await abortRunTestsStep(run.id);
    const finishedAt = run.finishedAt;
    assert.equal(hasActiveRunTestsStep(run.id), false, 'abort removes the entry while acquisition is pending');
    assert.equal(locks.releases, 0, 'the worker has not received the handle yet');

    delivery.resolve();
    await worker;
    assert.equal(locks.releases, 1, 'the late handle is released by the cancelled worker');
    assert.equal(await inspectProjectRunLock(run.projectPath), null);
    assert.equal(hasActiveRunTestsStep(run.id), false);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.finishedAt, finishedAt, 'late settlement preserves the cancellation');
    assert.equal(run.currentStepIndex, 0, 'no completion advanced the run');
    assert.equal(run.error, undefined);
    assert.equal(run.testStep, undefined);
    assert.deepEqual(calls, { head: 1, status: 0, checkpoint: 0, complete: 0 }, 'only preflight read HEAD');
    assert.equal(h.calls.spawn.length, 0);
    assert.equal(h.calls.writeState.length, 0, 'cancellation records no successful lastHead');
    assert.equal(subscriptions.added, 0, 'no spawn watcher was installed');
    await assert.rejects(fs.readFile(path.join(workflowStepDir(run.projectPath, run.id, 0), 'USER_WIP.txt')), { code: 'ENOENT' });

    await abortRunTestsStep(run.id);
    await abortRunTestsStep(run.id);
    assert.equal(locks.releases, 1, 'repeated abort does not release twice');
    assert.equal(run.status, 'cancelled');
  } finally {
    if (run) {
      cancelWorkflowRun(run.id);
      await abortRunTestsStep(run.id);
    }
    delivery.resolve();
    try {
      await worker;
    } finally {
      subscriptions.cleanup();
      try { await locks.cleanup(); } finally { await h.cleanup(); }
    }
  }
});

for (const spawned of [false, true]) {
  test(`a rejected finalization post-check stops the ${spawned ? 'timeout' : 'spawn subscription'} but holds the lock until I/O settles`, async (t) => {
    const commits = deferred<Awaited<ReturnType<RunTestsDeps['readCommitsSince']>>>();
    const readingCommits = deferred<void>();
    const failure = new Error('commit post-check I/O failed');
    const locks = trackedProjectLock();
    const subscriptions = controlledRunSubscriptions();
    let commitArgs: Parameters<RunTestsDeps['readCommitsSince']> | undefined;
    const h = await setup({
      acquireLock: locks.acquireLock,
      subscribeRuns: subscriptions.subscribeRuns,
      checkpoint: async () => {},
      minuteMs: 1000,
      readCommitsSince: (...args) => {
        commitArgs = args;
        readingCommits.resolve();
        return commits.promise;
      },
    });
    let run: WorkflowRun | undefined;
    let completion: Promise<void> | undefined;
    let completed = false;
    try {
      run = await trackedTestRun(h.project);
      await runRunTestsWorker(run.definition!, run, 0, ORIGIN, completeWorkflowStep);
      assert.equal(h.calls.spawn.length, 1);
      assert.equal(subscriptions.active, 1);
      assert.equal(subscriptions.removed, 0);
      assert.equal(hasActiveRunTestsStep(run.id), true);
      assert.deepEqual<WorkflowRun['testStep']>(run.testStep, { stepIndex: 0, startHead: 'aaaaaaa1' });

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const scheduled = t.mock.method(globalThis, 'setTimeout');
      const cleared = t.mock.method(globalThis, 'clearTimeout');
      const errors = t.mock.method(console, 'error', (..._args: unknown[]) => {});
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (spawned) {
        subscriptions.emit({ type: 'step-spawned', runId: run.id, projectPath: run.projectPath, stepIndex: 0, command: 'claude', cwd: '' });
        timeout = scheduled.mock.calls[0]?.result;
        assert.ok(timeout, 'the spawn armed a timeout');
        assert.equal(subscriptions.active, 0);
        assert.equal(subscriptions.removed, 1, 'the spawn consumes its subscription');
        assert.ok(run.testStep?.spawnedAt);
      }
      const checkpoint = { ...run.testStep! };
      completion = completeWorkflowStep(run.id, 0, ORIGIN).then(() => { completed = true; });
      await readingCommits.promise;

      assert.deepEqual(commitArgs, [run.projectPath, 'aaaaaaa1']);
      assert.equal(subscriptions.active, 0, 'finalization has stopped the spawn watcher before I/O');
      assert.equal(subscriptions.removed, 1, 'the subscription is removed exactly once');
      if (spawned) {
        assert.equal(cleared.mock.calls.filter((call) => call.arguments[0] === timeout).length, 1, 'the armed timeout was cleared before the post-check');
      }
      t.mock.timers.tick(5001);
      await Promise.resolve();
      assert.equal(h.calls.kill, 0, 'no timeout handling while finalization is pending');
      assert.equal(completed, false, 'completion is waiting for the post-check');
      assert.equal(run.status, 'running');
      assert.equal(run.currentStepIndex, 0);
      assert.equal(hasActiveRunTestsStep(run.id), true, 'stopping watchers retains the entry');
      assert.deepEqual(run.testStep, checkpoint, 'the matching checkpoint is retained during I/O');
      assert.equal(locks.releases, 0, 'finalization still owns the lock');
      assert.equal((await inspectProjectRunLock(run.projectPath))?.holder.label, runTestsLockLabel(run.id));
      await assert.rejects(acquireProjectRunLock(run.projectPath, 'manual-merge'), ProjectRunLockedError);

      commits.reject(failure);
      await completion;
      assert.ok(errors.mock.calls.some((call) => call.arguments.includes(failure)), 'the injected failure was contained by finalization');
      assert.equal(completed, true);
      assert.equal(run.status, 'completed', 'a post-check failure still permits workflow advancement');
      assert.equal(run.currentStepIndex, run.totalSteps);
      assert.equal(run.error, undefined);
      assert.equal(locks.releases, 1);
      assert.equal(await inspectProjectRunLock(run.projectPath), null);
      assert.equal(hasActiveRunTestsStep(run.id), false);
      assert.equal(run.testStep, undefined);
      assert.equal(h.calls.writeState.length, 0, 'a failed post-check records no successful lastHead');

      await abortRunTestsStep(run.id);
      await finalizeRunTestsStep(run, 0);
      assert.equal(locks.releases, 1, 'repeated cleanup does not release twice');
      assert.equal(subscriptions.removed, 1);
    } finally {
      commits.resolve([]);
      try {
        await completion;
      } finally {
        try {
          if (run) await abortRunTestsStep(run.id);
        } finally {
          subscriptions.cleanup();
          // Discard timer spies so automatic teardown cannot reinstall fake timers.
          t.mock.reset();
          try { await locks.cleanup(); } finally { await h.cleanup(); }
        }
      }
    }
  });
}

test('a rejected run-tests.json write still completes and releases the entry, checkpoint and lock once', async (t) => {
  const locks = trackedProjectLock();
  const failure = new Error('run-tests.json persistence failed');
  const writes: Array<{ project: string; state: Parameters<RunTestsDeps['writeState']>[1] }> = [];
  let head = 'aaaaaaa1';
  const h = await setup({
    acquireLock: locks.acquireLock,
    readHead: async () => head,
    readCommitsSince: async () => [{ sha: 'bbbbbbb', subject: 'fix the test', files: ['a.test.ts'] }],
    writeState: async (project, state) => { writes.push({ project, state }); throw failure; },
  });
  let run: WorkflowRun | undefined;
  try {
    run = await trackedTestRun(h.project);
    await runRunTestsWorker(run.definition!, run, 0, ORIGIN, completeWorkflowStep);
    assert.equal(h.calls.spawn.length, 1);
    assert.equal(hasActiveRunTestsStep(run.id), true);
    assert.equal((await inspectProjectRunLock(run.projectPath))?.holder.label, runTestsLockLabel(run.id));
    assert.equal(run.testStep?.stepIndex, 0);
    await fs.writeFile(path.join(workflowStepDir(run.projectPath, run.id, 0), 'TEST_SUMMARY.md'), 'All green.', 'utf8');
    head = 'ddddddd9';
    const warnings = t.mock.method(console, 'warn', (..._args: unknown[]) => {});

    await completeWorkflowStep(run.id, 0, ORIGIN);
    assert.ok(warnings.mock.calls.some((call) => call.arguments.includes(failure)), 'the state-write failure was contained');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].project, run.projectPath);
    assert.equal(writes[0].state.lastHead, 'ddddddd9', 'recording was attempted at the finish HEAD');
    assert.ok(writes[0].state.lastFinishedAt >= run.startedAt);
    assert.match(run.stepSummaries?.[0] ?? '', /All green/);
    assert.match(run.stepSummaries?.[0] ?? '', /bbbbbbb.*fix the test/);
    assert.equal(run.status, 'completed');
    assert.equal(run.currentStepIndex, run.totalSteps);
    assert.equal(run.error, undefined);
    assert.equal(locks.releases, 1);
    assert.equal(await inspectProjectRunLock(run.projectPath), null);
    assert.equal(hasActiveRunTestsStep(run.id), false);
    assert.equal(run.testStep, undefined);

    await abortRunTestsStep(run.id);
    await finalizeRunTestsStep(run, 0);
    await completeWorkflowStep(run.id, 0, ORIGIN);
    assert.equal(locks.releases, 1, 'repeated cleanup does not release twice');
    assert.equal(writes.length, 1, 'repeated finalization does not retry a completed state write');
  } finally {
    try {
      if (run) await abortRunTestsStep(run.id);
    } finally {
      t.mock.restoreAll();
      try { await locks.cleanup(); } finally { await h.cleanup(); }
    }
  }
});
