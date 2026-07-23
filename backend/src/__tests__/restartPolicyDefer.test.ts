import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyDeferAction,
  heldRunLockLabels,
  repoOperationInFlight,
  workflowRunInFlight,
  MAX_DEFER_MS,
} from '../../scripts/dev/restartPolicy.mjs';

// Regression for: the dev runner force-restarted the backend after 15 min while
// a workflow's Merge control step was legitimately holding the run.lock (waiting
// for its tasks to commit — routinely > 15 min). That wiped the in-memory
// workflow run, stranded its completed-but-unmerged tasks, and cascaded the
// queue onto the next workflow. A live `workflow-*` control-step lock must be
// EXEMPT from the force-restart backstop; a short, re-runnable merge-run lock
// still gets forced.

test('classifyDeferAction: nothing deferred → idle', () => {
  assert.equal(
    classifyDeferAction({ deferredSince: 0, now: 1000, operationInFlight: true, workflowInFlight: true }),
    'idle',
  );
});

test('classifyDeferAction: lock cleared → apply the deferred restart', () => {
  assert.equal(
    classifyDeferAction({ deferredSince: 1, now: 1000, operationInFlight: false, workflowInFlight: false }),
    'apply',
  );
});

test('classifyDeferAction: a live workflow past the window is HELD, never forced', () => {
  const deferredSince = 1;
  const now = deferredSince + MAX_DEFER_MS + 60 * 60 * 1000; // an hour past the backstop
  assert.equal(
    classifyDeferAction({ deferredSince, now, operationInFlight: true, workflowInFlight: true }),
    'hold-workflow',
  );
});

test('classifyDeferAction: a non-workflow op past the window IS forced', () => {
  const deferredSince = 1;
  const now = deferredSince + MAX_DEFER_MS + 1;
  assert.equal(
    classifyDeferAction({ deferredSince, now, operationInFlight: true, workflowInFlight: false }),
    'force',
  );
});

test('classifyDeferAction: a non-workflow op within the window is held', () => {
  const deferredSince = 1;
  const now = deferredSince + MAX_DEFER_MS - 1;
  assert.equal(
    classifyDeferAction({ deferredSince, now, operationInFlight: true, workflowInFlight: false }),
    'hold',
  );
});

test('heldRunLockLabels / workflowRunInFlight classify live locks by label and skip dead PIDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-restartpolicy-'));
  try {
    const write = async (hash: string, body: unknown) => {
      const d = path.join(dir, hash);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, 'run.lock'), JSON.stringify(body), 'utf8');
    };
    await write('aaaaaaaaaaaa', { pid: 1111, label: 'workflow-merge:wfrun_x' }); // live workflow
    await write('bbbbbbbbbbbb', { pid: 2222, label: 'merge-run' }); // live merge run
    await write('cccccccccccc', { pid: 3333, label: 'workflow-push:wfrun_y' }); // DEAD workflow

    // 1111/2222 alive, 3333 dead.
    const isPidAlive = (pid: number) => pid === 1111 || pid === 2222;
    const opts = { perProjectDir: dir, isPidAlive };

    const labels = heldRunLockLabels(opts).sort();
    assert.deepEqual(labels, ['merge-run', 'workflow-merge:wfrun_x'], 'dead-PID lock is excluded');
    assert.equal(repoOperationInFlight(opts), true);
    assert.equal(workflowRunInFlight(opts), true, 'a live workflow lock is detected');

    // Now only a live merge-run + the DEAD workflow lock → no LIVE workflow.
    const onlyMergeAlive = (pid: number) => pid === 2222;
    const opts2 = { perProjectDir: dir, isPidAlive: onlyMergeAlive };
    assert.equal(repoOperationInFlight(opts2), true);
    assert.equal(
      workflowRunInFlight(opts2),
      false,
      'a dead-PID workflow lock does not count — the backstop may force a merge-run restart',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
