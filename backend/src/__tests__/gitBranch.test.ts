// gitBranch.ts backs the navbar branch chip: getCurrentBranch derives the label
// and subscribeGitBranch pushes it live whenever `.git/HEAD` changes (a
// checkout). These assert the derivation and that a real checkout wakes a
// subscriber without a re-fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getCurrentBranch,
  subscribeGitBranch,
  _resetBranchWatchersForTest,
} from '../gitBranch.js';
import { withTempDir } from './helpers/tempDir.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(repo: string): Promise<string> {
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'lattice-test@example.invalid']);
  await git(repo, ['config', 'user.name', 'Lattice Test']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'hi\n');
  await git(repo, ['add', 'file.txt']);
  await git(repo, ['commit', '-m', 'base']);
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for branch update');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('getCurrentBranch returns the checked-out branch, null for a non-repo', async () => {
  await withTempDir('lattice-branch-', async (dir) => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const base = await initRepo(repo);
    assert.equal(await getCurrentBranch(repo), base);

    const plain = path.join(dir, 'plain');
    await fs.mkdir(plain, { recursive: true });
    assert.equal(await getCurrentBranch(plain), null);
  });
});

test('subscribeGitBranch delivers the current branch and updates on checkout', async () => {
  await withTempDir('lattice-branch-', async (dir) => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const base = await initRepo(repo);

    const seen: (string | null)[] = [];
    const unsub = await subscribeGitBranch(repo, (b) => seen.push(b));
    try {
      // The current branch is delivered immediately so a fresh subscriber can
      // paint the chip without waiting for a change.
      await waitFor(() => seen.length >= 1);
      assert.equal(seen[seen.length - 1], base);

      // A real checkout (what a terminal / the user would run) must wake the
      // subscriber with the new branch — no re-fetch, no refresh.
      await git(repo, ['checkout', '-b', 'lattice/feature']);
      await waitFor(() => seen[seen.length - 1] === 'lattice/feature');
      assert.equal(seen[seen.length - 1], 'lattice/feature');
    } finally {
      unsub();
      // Close the chokidar watcher before withTempDir removes the dir so it
      // doesn't emit errors on a vanished path or keep the loop alive.
      await _resetBranchWatchersForTest();
    }
  });
});
