// Worktree setup must not edit the project's TRACKED .gitignore. It used to
// append Lattice's managed entries there before every worktree creation, which
// left an uncommitted `.gitignore` edit on main whenever the managed list grew
// — on Lattice's own repo, after any merge that added an entry — dirtying the
// checkout merges fast-forward and colliding with tasks that edit .gitignore.
// The repo-local, untracked `.git/info/exclude` (common gitdir) carries the
// full managed set instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRepoRootAndPrepareProject } from '../worktree/setupProject.js';
import { LATTICE_GITIGNORE_ENTRIES } from '../worktree/managedFiles.js';
import { withTempDir } from './helpers/tempDir.js';

test('preparing a project for a worktree writes info/exclude and leaves the tracked .gitignore alone', async () => {
  await withTempDir('lattice-setup-gitignore-', async (repo) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    await fs.writeFile(path.join(repo, '.gitignore'), 'dist/\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    await resolveRepoRootAndPrepareProject(repo);

    assert.equal(await fs.readFile(path.join(repo, '.gitignore'), 'utf8'), 'dist/\n');
    assert.equal(git('status', '--porcelain').toString(), '', 'main stays clean');
    const exclude = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    for (const entry of LATTICE_GITIGNORE_ENTRIES) {
      assert.ok(exclude.split(/\r?\n/).includes(entry), `info/exclude covers ${entry}`);
    }
  });
});
