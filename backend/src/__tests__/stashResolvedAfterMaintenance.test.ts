// Since 1af479d startMergeRun refuses for the whole post-run housekeeping (a
// `git gc --auto` of up to 60 min). /stash-resolved and the resolver finalize
// restart the run for the remaining Ready-to-Merge tasks and swallowed ANY
// throw as "a run is already active and owns the rest" — so a snapshot-conflict
// resolver finishing during the gc stranded every remaining task (nothing
// retries after the gc) and fired the post-merge hook alongside the repack.
// Pins: the housekeeping refusal is typed, the restart waits for the gc and
// retries, and every other refusal is still rethrown for the caller to swallow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { Response } from 'express';
import { withTempDir } from './helpers/tempDir.js';
import { runRepoMaintenance, type RepoMaintenanceDeps } from '../worktree/repoMaintenance.js';
import {
  startMergeRun,
  startMergeRunAfterMaintenance,
  subscribe,
  type MergeRun,
} from '../mergeRuns.js';
import { RepoMaintenanceBusyError } from '../projectRunLock.js';
import { handleTaskStashResolved } from '../routes/tasks/hooks/stashResolved.js';
import { createTask, deleteTask, flushPersist, getTask, listTasks, updateTask } from '../tasks.js';
import { canonicalProjectPath, homeProjectDir } from '../projectPath.js';

const ORIGIN = 'http://127.0.0.1:5184';

type MockRes = {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
};
function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

// Start maintenance whose gc never finishes until `finish()` is called.
async function startHangingMaintenance(repo: string): Promise<{ done: Promise<void>; finish: () => void }> {
  let finish!: () => void;
  let gcStarted!: () => void;
  const started = new Promise<void>((r) => { gcStarted = r; });
  const overrides: Partial<RepoMaintenanceDeps> = {
    freeBytesAt: async () => 1e15,
    minFreeBytes: async () => 0,
    isBusy: () => false,
    runGc: () => {
      gcStarted();
      return new Promise((resolve) => {
        finish = () => resolve({ code: 0, stdout: '', stderr: '' });
      });
    },
  };
  const done = runRepoMaintenance(repo, overrides);
  await started;
  return { done, finish: () => finish() };
}

test('/stash-resolved during the housekeeping gc restarts the merge run for the remaining task once the gc ends', async () => {
  await withTempDir('lattice-stash-resolved-gc-', async (dir) => {
    const repo = canonicalProjectPath(dir);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const resolved = await createTask(repo, 'snapshot-conflict resolved');
    const remaining = await createTask(repo, 'still ready to merge');
    await updateTask(resolved.id, { status: 'ready_to_merge' });
    await updateTask(remaining.id, { status: 'ready_to_merge' });

    const started: MergeRun[] = [];
    const settled: MergeRun[] = [];
    const unsub = subscribe((ev) => {
      if (ev.type === 'started' && ev.run.projectPath === repo) started.push(ev.run);
      if (ev.type === 'completed' && ev.run.projectPath === repo) settled.push(ev.run);
    });
    // The real startMergeRun (with its housekeeping gate) over the real task
    // store; the worker halts at preflight so no git merge is attempted.
    const runDeps = {
      listTasks,
      runPreflight: async () => { throw new Error('test worker halted'); },
      processTarget: async () => 'halt' as const,
    };

    const { done, finish } = await startHangingMaintenance(repo);
    let handled: Promise<void> | undefined;
    try {
      const res = mockRes();
      handled = handleTaskStashResolved(ORIGIN, {
        cleanupWorktree: async () => true,
        startMergeRun: (p, o) =>
          startMergeRunAfterMaintenance(p, o, {}, { start: (sp, so, opts) => startMergeRun(sp, so, opts, runDeps) }),
      })(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { params: { id: resolved.id }, query: {} } as any,
        res as unknown as Response,
      ).then(() => {
        assert.deepEqual(res.body, { ok: true });
      });

      await new Promise((r) => setTimeout(r, 100));
      assert.equal((await getTask(resolved.id))?.status, 'qa');
      assert.equal(started.length, 0, 'no merge run alongside the repack');

      finish();
      await done;
      await handled;

      assert.equal(started.length, 1, 'the refused restart is retried once the gc ends');
      assert.equal(started[0].total, 1, 'the run picks up the remaining ready_to_merge task');
      assert.equal((await getTask(remaining.id))?.status, 'ready_to_merge');
      for (let i = 0; i < 50 && settled.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 50)); // the worker releases run.lock after its completed event
    } finally {
      finish();
      await done;
      await handled?.catch(() => {});
      unsub();
      await deleteTask(resolved.id);
      await deleteTask(remaining.id);
      await flushPersist(repo).catch(() => {});
      await fs.rm(homeProjectDir(repo), { recursive: true, force: true }).catch(() => {});
    }
  });
});

test('startMergeRunAfterMaintenance rethrows every refusal other than the housekeeping one', async () => {
  let waits = 0;
  const active = new Error('A merge run is already in progress for this project.');
  await assert.rejects(
    startMergeRunAfterMaintenance('C:/p', ORIGIN, {}, {
      start: async () => { throw active; },
      waitForMaintenance: async () => { waits++; return true; },
    }),
    (err) => err === active,
  );
  assert.equal(waits, 0, '"a run is already active" is not waited on');

  // Housekeeping refusal: wait, then retry.
  let attempts = 0;
  const run = { id: 'mr', total: 2 } as MergeRun;
  const got = await startMergeRunAfterMaintenance('C:/p', ORIGIN, {}, {
    start: async () => {
      attempts++;
      if (attempts === 1) throw new RepoMaintenanceBusyError();
      return run;
    },
    waitForMaintenance: async () => { waits++; return true; },
  });
  assert.equal(got, run);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);

  // A wait that times out gives up with the busy error rather than spinning.
  await assert.rejects(
    startMergeRunAfterMaintenance('C:/p', ORIGIN, {}, {
      start: async () => { throw new RepoMaintenanceBusyError(); },
      waitForMaintenance: async () => false,
    }),
    RepoMaintenanceBusyError,
  );
});
