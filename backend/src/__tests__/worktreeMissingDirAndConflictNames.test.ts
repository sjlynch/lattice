// Real-git regressions for two worktree/state.ts read helpers:
//
//  1. `isMidMerge` on a directory that doesn't exist. The spawn itself fails
//     there (`exec` rejects with `spawn git ENOENT`), and isMidMerge let that
//     escape — so `handleFlaggedConflictTask` threw on a conflict-flagged task
//     whose worktree had been deleted by hand, which propagated out of
//     `processTarget` and crashed the whole merge-run worker (every remaining
//     task left unprocessed). A missing directory is simply "not mid-merge";
//     the normal merge path then re-creates the checkout from its branch.
//  2. `listConflictedFiles` without `-z`: git C-quoted any path with a
//     non-ASCII byte (`"caf\303\251.txt"`), which is not a usable path for the
//     `git checkout --ours -- <file>` auto-resolve or the resolver brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMidMerge, listConflictedFiles } from '../worktree/state.js';
import { handleFlaggedConflictTask } from '../mergeRuns/flaggedConflict.js';
import type { Task } from '../tasks.js';
import type { MergeRun } from '../mergeRuns/state.js';
import { createRunState } from '../mergeRuns/state.js';
import { withTempDir } from './helpers/tempDir.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();
}

async function initRepo(repo: string): Promise<void> {
  await fs.mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, ...ID, 'commit', '-qm', 'base');
}

test('isMidMerge reports a missing directory as not mid-merge instead of throwing', async () => {
  await withTempDir('lattice-midmerge-missing-', async (root) => {
    assert.equal(await isMidMerge(path.join(root, 'does-not-exist')), false);
  });
});

test('a conflict-flagged task with a hand-deleted worktree falls through instead of crashing the run', async () => {
  await withTempDir('lattice-flagged-missing-', async (root) => {
    const repo = path.join(root, 'repo');
    await initRepo(repo);
    const task = {
      id: 'task-missing-wt',
      title: 'missing worktree',
      projectPath: repo,
      status: 'ready_to_merge',
      conflict: true,
      branch: 'lattice/missing-wt',
      worktreePath: path.join(root, 'gone-worktree'),
      createdAt: 1,
    } as unknown as Task;
    const run: MergeRun = {
      id: 'run-missing-wt', projectPath: repo, status: 'running', startedAt: 1,
      total: 1, processed: 0, merged: [], conflicted: [], errored: [], cancelRequested: false,
    };
    const runCtx = { projectPath: repo, backendOrigin: 'http://unused', baselineHead: null, state: createRunState() };
    const result = await handleFlaggedConflictTask(task, run, runCtx, () => ({}));
    assert.deepEqual(result, { action: 'fallthrough' });
  });
});

test('listConflictedFiles returns non-ASCII conflicted paths verbatim, not C-quoted', async () => {
  await withTempDir('lattice-conflict-names-', async (root) => {
    const repo = path.join(root, 'repo');
    await initRepo(repo);
    const name = 'café.txt';
    await fs.writeFile(path.join(repo, name), 'base\n');
    git(repo, 'add', '-A');
    git(repo, ...ID, 'commit', '-qm', 'add file');
    git(repo, 'checkout', '-q', '-b', 'side');
    await fs.writeFile(path.join(repo, name), 'side\n');
    git(repo, ...ID, 'commit', '-qam', 'side');
    git(repo, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(repo, name), 'main\n');
    git(repo, ...ID, 'commit', '-qam', 'main');
    assert.throws(() => git(repo, ...ID, 'merge', 'side'));
    assert.equal(await isMidMerge(repo), true);
    assert.deepEqual(await listConflictedFiles(repo), [name]);
  });
});
