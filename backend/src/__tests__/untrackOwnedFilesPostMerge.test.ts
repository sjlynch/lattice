import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { untrackOwnedFilesPostMerge } from '../worktree/mergeOwnedFiles.js';
import { withTempDir } from './helpers/tempDir.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function repoTrackingTaskFile(dir: string): Promise<void> {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 'lattice-test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'LATTICE_TASK.md'), 'brief\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

test('untrackOwnedFilesPostMerge untracks an accidentally committed owned file', async (t) => {
  t.mock.method(console, 'log', () => {});
  await withTempDir('lattice-untrack-ok-', async (dir) => {
    await repoTrackingTaskFile(dir);
    await untrackOwnedFilesPostMerge(dir);
    assert.equal(git(dir, ['ls-files', 'LATTICE_TASK.md']).trim(), '');
    assert.equal(git(dir, ['status', '--porcelain', '--untracked-files=no']).trim(), '');
  });
});

// Regression: the `git commit` exit code was ignored. A repo commit-msg hook
// rejecting the message left the `rm --cached` deletions staged in the
// worktree index while the log claimed success.
test('untrackOwnedFilesPostMerge un-stages its deletions when the commit is rejected', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await withTempDir('lattice-untrack-hook-', async (dir) => {
    await repoTrackingTaskFile(dir);
    const hook = path.join(dir, '.git', 'hooks', 'commit-msg');
    await fs.writeFile(hook, '#!/bin/sh\necho "rejected by commitlint" >&2\nexit 1\n', { mode: 0o755 });
    await untrackOwnedFilesPostMerge(dir);
    assert.equal(git(dir, ['ls-files', 'LATTICE_TASK.md']).trim(), 'LATTICE_TASK.md');
    assert.equal(git(dir, ['diff', '--cached', '--name-only']).trim(), '', 'no staged deletion may be left behind');
  });
});
