import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorktreeWithRetries } from '../worktree/setupAdd.js';
import { homeWorktreesDir } from '../projectPath.js';
import { withTempDir } from './helpers/tempDir.js';

// Regression: since git 2.42, `git worktree add <p> -b <branch>` in a repo
// with no commits SUCCEEDS ("No possible source branch, inferring '--orphan'"),
// so the "no commits yet" error keyed on git's old failure text never fired
// and the task ran on an orphan branch whose /complete commit count
// (`HEAD..branch`) could never be computed. setup must refuse up front.
test('worktree setup refuses a repo with no commits instead of creating an orphan branch', async () => {
  await withTempDir('lattice-setup-empty-', async (root) => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const worktreesDir = homeWorktreesDir(repo);
    const candidatePath = path.join(worktreesDir, 'empty-abc');
    try {
      await assert.rejects(
        addWorktreeWithRetries(repo, {
          slug: 'empty',
          shortId: 'abc',
          worktreesDir,
          candidates: [{ attempt: 0, suffix: '', candidatePath, candidateBranch: 'lattice/empty-abc' }],
        }, 'empty repo task'),
        /has no commits yet/,
      );
      await assert.rejects(fs.access(candidatePath));
      const branches = execFileSync('git', ['branch', '--list', 'lattice/*'], { cwd: repo, encoding: 'utf8' });
      assert.equal(branches.trim(), '');
    } finally {
      await fs.rm(worktreesDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
