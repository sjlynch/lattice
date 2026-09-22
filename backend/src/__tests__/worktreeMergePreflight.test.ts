import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflightWorktreeMerge } from '../worktree/merge/preflight.js';
import { fastForwardMain } from '../worktree/merge.js';
import { homeWorktreesDir } from '../projectPath.js';
import { withTempDir } from './helpers/tempDir.js';

// Real-git regressions for two preflight holes in the worktree merge:
//
//  1. A DETACHED HEAD in the project checkout. `git merge --ff-only` merges
//     into whatever HEAD is — on a detached HEAD the branch tip lands only
//     there, `main` never moves, and cleanup then deletes the `lattice/*`
//     branch, leaving the merged commits reachable from nothing but the
//     reflog. Both the worktree-merge preflight and the FF itself now refuse.
//  2. A hand-deleted worktree DIRECTORY whose branch still exists. Preflight
//     used to fail forever with "Worktree directory not found"; it now
//     re-creates the checkout from the branch (and re-installs the Stop hook)
//     so the task can still merge.

const BRANCH = 'lattice/preflight-test';
const exists = (p: string) => fs.access(p).then(() => true, () => false);

async function withFixture(fn: (f: { repo: string; worktree: string; git: (cwd: string, ...args: string[]) => string }) => Promise<void>) {
  // The worktree must live under the (isolated) home worktrees dir: the
  // re-create path runs assertSafeWorktreePath before touching git.
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  await withTempDir('lattice-preflight-', async (root) => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();
    await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
    git(repo, 'init', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    const base = homeWorktreesDir(repo);
    await fs.mkdir(base, { recursive: true });
    const worktree = path.join(base, 'preflight-task');
    git(repo, 'worktree', 'add', '-q', '-b', BRANCH, worktree);
    await fs.writeFile(path.join(worktree, 'work.txt'), 'task work\n');
    git(worktree, 'add', '-A');
    git(worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'work');
    try {
      await fn({ repo, worktree, git });
    } finally {
      assert.ok(path.resolve(base).startsWith(path.resolve(os.homedir()) + path.sep));
      await fs.rm(base, { recursive: true, force: true });
    }
  });
}

test('a detached HEAD in the project checkout is refused by preflight AND by the fast-forward', async () => {
  await withFixture(async ({ repo, worktree, git }) => {
    git(repo, 'checkout', '-q', '--detach');

    const preflight = await preflightWorktreeMerge(repo, BRANCH, worktree);
    assert.equal(preflight.ok, false);
    if (preflight.ok) return;
    assert.equal(preflight.outcome.status, 'error');
    assert.match(preflight.outcome.status === 'error' ? preflight.outcome.message : '', /detached HEAD/);

    const ff = await fastForwardMain(repo, BRANCH);
    assert.equal(ff.status, 'error');
    assert.match(ff.status === 'error' ? ff.message : '', /detached HEAD/);
    // Nothing moved: main still lacks the branch commit.
    assert.equal(git(repo, 'rev-list', '--count', `main..${BRANCH}`).trim(), '1');

    git(repo, 'checkout', '-q', 'main');
    const ok = await preflightWorktreeMerge(repo, BRANCH, worktree);
    assert.equal(ok.ok, true);
  });
});

test('a hand-deleted worktree directory is re-created from its branch, with the Stop hook re-installed', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
  await withFixture(async ({ repo, worktree, git }) => {
    await fs.rm(worktree, { recursive: true, force: true });
    assert.match(git(repo, 'worktree', 'list', '--porcelain'), /prunable/);

    const result = await preflightWorktreeMerge(repo, BRANCH, worktree, {
      taskId: 'task-preflight',
      backendOrigin: 'http://127.0.0.1:1',
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await exists(worktree), true);
    assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), BRANCH);
    // A fresh checkout may apply core.autocrlf — compare line-ending-agnostic.
    assert.equal((await fs.readFile(path.join(worktree, 'work.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'task work\n');
    const hook = await fs.readFile(path.join(worktree, '.claude', 'settings.local.json'), 'utf8');
    assert.ok(hook.includes('task-preflight'), 'the Stop hook targets this task again');
    assert.ok(warnings.some((w) => /re-created it from branch/.test(w)));
  });
});

test('a missing worktree whose branch is also gone still fails preflight', async () => {
  await withFixture(async ({ repo, worktree, git }) => {
    git(repo, 'worktree', 'remove', '--force', worktree);
    git(repo, 'branch', '-D', BRANCH);

    const result = await preflightWorktreeMerge(repo, BRANCH, worktree, {
      taskId: 'task-preflight',
      backendOrigin: 'http://127.0.0.1:1',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.outcome.status === 'error' ? result.outcome.message : '', /Worktree directory not found/);
    assert.equal(await exists(worktree), false);
  });
});
