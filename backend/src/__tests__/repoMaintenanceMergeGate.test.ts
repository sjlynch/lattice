// The post-merge-run housekeeping (worktree/repoMaintenance.ts) checked "is the
// project merging?" only BEFORE its foreground `git gc --auto` (up to 60 min).
// A merge run started during the gc — Merge All, a workflow Merge step, the
// low-disk trigger — mapped the packs the repack was replacing, and on Windows
// the old ones then couldn't be deleted: the 9af5a47 full-leftover-pack-copy
// failure. Pins: while the gc runs it holds the project run lock, startMergeRun
// refuses with a message naming the housekeeping, a workflow control step waits
// for it instead of failing, and everything is released when the gc ends.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { withTempDir } from './helpers/tempDir.js';
import {
  isRepoMaintenanceRunning,
  runRepoMaintenance,
  waitForRepoMaintenance,
  type RepoMaintenanceDeps,
} from '../worktree/repoMaintenance.js';
import { startMergeRun } from '../mergeRuns.js';
import { acquireProjectRunLock, ProjectRunLockedError } from '../projectRunLock.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import { homeProjectDir } from '../projectPath.js';
import type { Workflow } from '../workflows.js';
import type { WorkflowRun } from '../workflowRuns/state.js';

const PREFIX = 'lattice-repo-maint-gate-';

function initRepo(repo: string): void {
  execFileSync('git', ['init', '-q'], { cwd: repo });
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

async function cleanupHome(repo: string): Promise<void> {
  await fs.rm(homeProjectDir(repo), { recursive: true, force: true }).catch(() => {});
}

test('a merge run cannot start while the housekeeping gc is running', async () => {
  await withTempDir(PREFIX, async (repo) => {
    initRepo(repo);
    const { done, finish } = await startHangingMaintenance(repo);
    try {
      assert.equal(isRepoMaintenanceRunning(repo), true);

      await assert.rejects(startMergeRun(repo, 'http://localhost'), /git gc --auto/);

      // Any other merge path (manual /merge, a workflow step, another backend)
      // meets the run lock the gc holds, with a message that says why.
      await assert.rejects(acquireProjectRunLock(repo, 'manual-merge'), (err: unknown) => {
        assert.ok(err instanceof ProjectRunLockedError);
        assert.match(err.message, /git gc --auto/);
        return true;
      });
    } finally {
      finish();
      await done;
    }

    assert.equal(isRepoMaintenanceRunning(repo), false);
    // The lock was released with the gc.
    const lock = await acquireProjectRunLock(repo, 'manual-merge');
    await lock.release();
    await cleanupHome(repo);
  });
});

test('waitForRepoMaintenance is bounded and resolves once the gc ends', async () => {
  await withTempDir(PREFIX, async (repo) => {
    initRepo(repo);
    assert.equal(await waitForRepoMaintenance(repo, 10), true, 'idle project: no wait');
    const { done, finish } = await startHangingMaintenance(repo);
    try {
      assert.equal(await waitForRepoMaintenance(repo, 30), false, 'still running after the bound');
      const waited = waitForRepoMaintenance(repo, 60_000);
      finish();
      assert.equal(await waited, true);
    } finally {
      finish();
      await done;
    }
    await cleanupHome(repo);
  });
});

test('a workflow control step waits for the housekeeping gc before taking the lock', async () => {
  await withTempDir(PREFIX, async (repo) => {
    initRepo(repo);
    const { done, finish } = await startHangingMaintenance(repo);
    const acquireLock = mock.fn(async () => ({ release: async () => undefined }));
    const wf = { projectPath: repo, steps: [{ kind: 'merge' }] } as Workflow;
    const run: WorkflowRun = {
      id: 'wfrun_maint',
      workflowId: 'wf',
      workflowName: 'wf',
      projectPath: repo,
      status: 'running',
      startedAt: 1,
      totalSteps: 1,
      currentStepIndex: 0,
    };
    let completed = false;
    const worker = runControlStepWorker(wf, run, 0, 'http://localhost', async () => { completed = true; }, {
      acquireLock,
      runStart: async () => undefined,
      runMerge: async () => undefined,
      runPush: async () => undefined,
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(acquireLock.mock.callCount(), 0, 'no lock (and no merge) while the gc runs');
    } finally {
      finish();
      await done;
    }
    await worker;
    assert.equal(acquireLock.mock.callCount(), 1);
    assert.equal(completed, true);
    await cleanupHome(repo);
  });
});
