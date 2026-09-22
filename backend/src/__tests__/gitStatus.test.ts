// gitStatus.ts backs the timeline scrubber's live refresh: computeStatusSignature
// fingerprints the repo state (HEAD + dirty set) and subscribeGitStatus wakes a
// subscriber whenever a commit or a working-tree edit changes it. These pin the
// two bugs the feature fixes — the signature must move both when the tree goes
// dirty AND when a commit cleans it, and a real edit/commit must wake a live
// subscriber without a page refresh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeStatusSignature } from '../gitHistory/signature.js';
import {
  subscribeGitStatus,
  _resetGitStatusWatchersForTest,
} from '../gitStatus.js';
import { withTempDir } from './helpers/tempDir.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(repo: string): Promise<void> {
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'lattice-test@example.invalid']);
  await git(repo, ['config', 'user.name', 'Lattice Test']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'hi\n');
  await git(repo, ['add', 'file.txt']);
  await git(repo, ['commit', '-m', 'base']);
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for git-status update');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('computeStatusSignature moves when the tree goes dirty and when a commit cleans it', async () => {
  await withTempDir('lattice-gitstatus-', async (dir) => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await initRepo(repo);

    const clean1 = await computeStatusSignature(repo);
    assert.ok(clean1, 'a real repo yields a non-empty signature');

    // An unstaged edit dirties the tree → signature must change (this is the
    // "doesn't update to dirty" half of the bug).
    await fs.appendFile(path.join(repo, 'file.txt'), 'more\n');
    const dirty = await computeStatusSignature(repo);
    assert.notEqual(dirty, clean1, 'dirtying the working tree changes the signature');

    // Committing clears the dirt AND moves HEAD → signature must change again,
    // and must differ from the pre-edit clean state (new HEAD) — the "still
    // shows uncommitted after commit" half of the bug.
    await git(repo, ['commit', '-am', 'edit']);
    const clean2 = await computeStatusSignature(repo);
    assert.notEqual(clean2, dirty, 'committing changes the signature');
    assert.notEqual(clean2, clean1, 'a new HEAD is distinguishable from the old clean state');
  });
});

test('computeStatusSignature returns empty for a non-repo folder', async () => {
  await withTempDir('lattice-gitstatus-', async (dir) => {
    const plain = path.join(dir, 'plain');
    await fs.mkdir(plain, { recursive: true });
    assert.equal(await computeStatusSignature(plain), '');
  });
});

test('subscribeGitStatus delivers the current signature and wakes on an edit + commit', async () => {
  await withTempDir('lattice-gitstatus-', async (dir) => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await initRepo(repo);

    const seen: string[] = [];
    const unsub = await subscribeGitStatus(repo, (sig) => seen.push(sig));
    try {
      // Current signature delivered immediately so a fresh/reconnecting client
      // can dedupe against what it already fetched.
      await waitFor(() => seen.length >= 1);
      const initial = seen[seen.length - 1];
      assert.ok(initial, 'initial signature is non-empty for a repo');

      // A working-tree edit (no git command) must wake the subscriber — the fix
      // for "a fresh edit doesn't light up as dirty". chokidar's recursive
      // directory watch only detects changes once its initial scan completes,
      // so re-touch until it's live; each append keeps the tree dirty, so the
      // first one it catches is enough (the dirty signature is content-stable).
      const file = path.join(repo, 'file.txt');
      const dirtyStart = Date.now();
      while (seen[seen.length - 1] === initial) {
        await fs.appendFile(file, 'more\n');
        if (Date.now() - dirtyStart > 10000) {
          throw new Error('timed out waiting for the tree to register dirty');
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      const dirty = seen[seen.length - 1];
      assert.notEqual(dirty, initial);

      // A commit must wake it again with yet another signature — the fix for
      // "still shows uncommitted after committing".
      await git(repo, ['commit', '-am', 'edit']);
      await waitFor(() => seen[seen.length - 1] !== dirty);
      assert.notEqual(seen[seen.length - 1], dirty);
    } finally {
      unsub();
      // Close the chokidar watchers before withTempDir removes the dir so they
      // don't emit errors on a vanished path or keep the loop alive.
      await _resetGitStatusWatchersForTest();
    }
  });
});

// The working-tree filter used to be frozen at subscribe time: un-ignoring a
// directory in the root .gitignore left every later edit under it filtered
// out, so a file git had just started reporting as untracked never woke the
// scrubber.
test('subscribeGitStatus reloads the root .gitignore so un-ignored paths wake it', async () => {
  await withTempDir('lattice-gitstatus-', async (dir) => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), 'gen/\n');
    await initRepo(repo);
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-m', 'ignore gen']);

    const seen: string[] = [];
    const unsub = await subscribeGitStatus(repo, (sig) => seen.push(sig));
    try {
      await waitFor(() => seen.length >= 1);
      const initial = seen[seen.length - 1];
      // Un-ignore gen/ (itself a dirtying edit — retry until the watcher is live).
      const start = Date.now();
      while (seen[seen.length - 1] === initial) {
        await fs.writeFile(path.join(repo, '.gitignore'), `# nothing ignored ${Date.now()}\n`);
        if (Date.now() - start > 10000) throw new Error('timed out waiting for .gitignore edit');
        await new Promise((r) => setTimeout(r, 300));
      }
      // Let the index-refresh echo of that recompute settle, so the next wake
      // can only come from the gen/ write itself.
      await new Promise((r) => setTimeout(r, 1500));
      const afterIgnoreEdit = seen[seen.length - 1];

      await fs.mkdir(path.join(repo, 'gen'), { recursive: true });
      await fs.writeFile(path.join(repo, 'gen', 'new.txt'), 'now visible to git\n');
      await waitFor(() => seen[seen.length - 1] !== afterIgnoreEdit);
      assert.notEqual(seen[seen.length - 1], afterIgnoreEdit);
    } finally {
      unsub();
      await _resetGitStatusWatchersForTest();
    }
  });
});

// A project opened on a SUBFOLDER of a repo has no `<project>/.git`; probing
// only that path left it with no watchers at all, so commits never refreshed
// the scrubber. The git dir is found by walking up, as git does.
test('subscribeGitStatus watches the enclosing repo of a nested project folder', async () => {
  await withTempDir('lattice-gitstatus-', async (dir) => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await initRepo(repo);
    const sub = path.join(repo, 'packages', 'app');
    await fs.mkdir(sub, { recursive: true });

    const seen: string[] = [];
    const unsub = await subscribeGitStatus(sub, (sig) => seen.push(sig));
    try {
      await waitFor(() => seen.length >= 1);
      const initial = seen[seen.length - 1];
      assert.ok(initial, 'a nested folder still yields the repo signature');
      // A commit elsewhere in the repo (no working-tree event under `sub`) must
      // be seen through the git-metadata watcher.
      await fs.appendFile(path.join(repo, 'file.txt'), 'more\n');
      await new Promise((r) => setTimeout(r, 500));
      await git(repo, ['commit', '-am', 'outside the project folder']);
      await waitFor(() => seen[seen.length - 1] !== initial);
    } finally {
      unsub();
      await _resetGitStatusWatchersForTest();
    }
  });
});
