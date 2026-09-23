import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { cleanupWorktreeForTask, type WorktreeCleanupDeps } from '../worktree/cleanup.js';
import { projectGit } from '../worktree/projectGit.js';
import { exec } from '../worktree/exec.js';
import { withTempDir } from './helpers/tempDir.js';
import { keptBranchPayload } from '../routes/tasks/crudDelete.js';

async function fixture(fn: (f: {
  repo: string; worktree: string; branch: string; calls: string[][]; kills: string[];
  deps: WorktreeCleanupDeps; git: (args: string[]) => Promise<string>;
}) => Promise<void>) {
  await withTempDir('lattice-cleanup-', async (repo) => {
    const git = async (args: string[]) => {
      const result = await exec('git', args, repo);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
      return result.stdout;
    };
    await git(['init', '-q']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-qm', 'initial']);
    const worktree = path.join(repo, '.lattice', 'worktrees', 'tâche-space');
    const branch = 'lattice/cleanup-test';
    await git(['worktree', 'add', '-b', branch, worktree]);
    const calls: string[][] = [];
    const kills: string[] = [];
    const deps: WorktreeCleanupDeps = {
      projectGit: async (...args) => { calls.push(args[1]); return projectGit(...args); },
      proxyKillSessionsByCwd: async (cwd) => { kills.push(cwd); },
      notifySessionsFreed: () => undefined,
    };
    await fn({ repo, worktree, branch, calls, kills, deps, git });
  });
}

function guardedRemoveFixture(repo: string, target: string) {
  const relative = path.relative(path.resolve(repo), path.resolve(target));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  return fs.rm(target, { recursive: true, force: true });
}

test('cleanup removes a registered worktree with a non-ASCII path and is idempotent', async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  await fixture(async ({ repo, worktree, branch, deps, git, kills }) => {
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), true);
    await assert.rejects(fs.lstat(worktree), { code: 'ENOENT' });
    assert.equal((await git(['branch', '--list', branch])).trim(), '');
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), true);
    assert.deepEqual(kills, [worktree]);
    assert.deepEqual(warnings, []);
  });
});

test('cleanup unregisters a manually deleted worktree before removing its branch', async () => {
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    await guardedRemoveFixture(repo, worktree);
    assert.match(await git(['worktree', 'list', '--porcelain']), /prunable/);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), true);
    assert.equal((await git(['branch', '--list', branch])).trim(), '');
  });
});

test('failed Git removal preserves registration and branch without attempting branch deletion', async () => {
  await fixture(async ({ repo, worktree, branch, deps, calls, git }) => {
    const real = deps.projectGit;
    deps.projectGit = async (...args) => args[1][1] === 'remove'
      ? { code: 1, stdout: '', stderr: 'permission denied removing worktree' }
      : real(...args);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.ok((await fs.lstat(worktree)).isDirectory());
    assert.match(await git(['worktree', 'list', '--porcelain']), /refs\/heads\/lattice\/cleanup-test/);
    assert.ok(!calls.some((args) => args[0] === 'branch' && args[1] === '-D'));
    assert.ok(!calls.some((args) => args[1] === 'prune'));
  });
});

// Windows' usual failure: git stops at the first locked file but has already
// dropped the registration and `.git`. Simulated by letting the real removal
// run and then recreating some of the tree as the "survivors".
function residueLeavingRemove(deps: WorktreeCleanupDeps, worktree: string) {
  const real = deps.projectGit;
  deps.projectGit = async (...args) => {
    if (args[1][0] !== 'worktree' || args[1][1] !== 'remove') return real(...args);
    const removed = await real(...args);
    assert.equal(removed.code, 0, removed.stderr);
    await fs.mkdir(path.join(worktree, 'packages', 'app'), { recursive: true });
    await fs.writeFile(path.join(worktree, 'packages', 'app', 'index.ts'), 'survivor');
    return { code: 1, stdout: '', stderr: `error: failed to delete '${worktree}': Invalid argument` };
  };
}

test('a failed removal whose registration git already dropped deletes the branch and leaves residue', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(String(args[0])));
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    let freed = 0;
    deps.notifyDiskSpaceFreed = () => { freed += 1; };
    residueLeavingRemove(deps, worktree);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), true);
    assert.equal((await git(['branch', '--list', branch])).trim(), '', 'branch must not leak');
    assert.ok((await fs.lstat(path.join(worktree, 'packages'))).isDirectory(), 'residue is not fs.rm-ed here');
    assert.equal(freed, 1);
    assert.ok(warnings.some((w) => /left for the residue sweep/.test(w)), warnings.join('\n'));
    assert.ok(!warnings.some((w) => /boot-time orphan sweep will retry/.test(w)));
  });
});

test('a failed removal with the registration gone still honours keepBranchIfUnmerged', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    await commitInWorktree(worktree, 2);
    residueLeavingRemove(deps, worktree);
    const kept: unknown[] = [];
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps, {
      keepBranchIfUnmerged: true, onBranchKept: (info) => kept.push(info),
    }), true);
    assert.ok((await git(['branch', '--list', branch])).includes(branch));
    assert.deepEqual(kept, [{ name: branch, unmergedCommits: 2 }]);
  });
});

test('explicitly locked worktrees preserve terminals, files and branch', async () => {
  await fixture(async ({ repo, worktree, branch, deps, calls, kills, git }) => {
    await git(['worktree', 'lock', '--reason', 'keep for recovery', worktree]);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.deepEqual(kills, []);
    assert.ok(!calls.some((args) => args[1] === 'remove' || args[1] === '-D'));
    assert.ok((await fs.lstat(worktree)).isDirectory());
  });
});

test('a worktree moved to another location keeps its branch and files', async () => {
  await fixture(async ({ repo, worktree, branch, deps, calls, kills, git }) => {
    const moved = path.join(repo, 'user-moved-checkout');
    await git(['worktree', 'move', worktree, moved]);
    await fs.writeFile(path.join(moved, 'keep.txt'), 'user changes');
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.equal(await fs.readFile(path.join(moved, 'keep.txt'), 'utf8'), 'user changes');
    assert.deepEqual(kills, []);
    assert.ok(!calls.some((args) => args[0] === 'branch' && args[1] === '-D'));
  });
});

test('a different branch now checked out at the task path prevents teardown', async () => {
  await fixture(async ({ repo, worktree, branch, deps, kills }) => {
    const switched = await exec('git', ['checkout', '-b', 'user-recovery'], worktree);
    assert.equal(switched.code, 0, switched.stderr);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.deepEqual(kills, []);
    assert.ok((await fs.lstat(worktree)).isDirectory());
  });
});

test('a formerly detached checkout that now has a branch is preserved', async () => {
  await fixture(async ({ repo, worktree, deps, kills }) => {
    assert.equal(await cleanupWorktreeForTask(repo, worktree, '', deps), false);
    assert.deepEqual(kills, []);
    assert.ok((await fs.lstat(worktree)).isDirectory());
  });
});

test('an intentionally detached checkout can still be cleaned without deleting its old branch', async () => {
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    const detached = await exec('git', ['checkout', '--detach'], worktree);
    assert.equal(detached.code, 0, detached.stderr);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, '', deps), true);
    await assert.rejects(fs.lstat(worktree), { code: 'ENOENT' });
    assert.ok((await git(['branch', '--list', branch])).includes(branch));
  });
});

test('an unregistered existing directory is preserved before terminal or filesystem cleanup', async () => {
  await fixture(async ({ repo, worktree, branch, deps, kills, git }) => {
    await git(['worktree', 'remove', '--force', worktree]);
    await fs.mkdir(worktree);
    const sentinel = path.join(worktree, 'keep.txt');
    await fs.writeFile(sentinel, 'not a registered worktree');
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'not a registered worktree');
    assert.deepEqual(kills, []);
  });
});

test('failed or empty registration inventories defer cleanup', async () => {
  await fixture(async ({ repo, worktree, branch, deps, kills }) => {
    for (const code of [1, 0]) {
      deps.projectGit = async () => ({ code, stdout: '', stderr: '' });
      assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    }
    assert.deepEqual(kills, []);
    assert.ok((await fs.lstat(worktree)).isDirectory());
  });
});

test('a failed registration recheck after removal preserves the branch', async () => {
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    const real = deps.projectGit;
    let lists = 0;
    deps.projectGit = async (...args) => args[1][1] === 'list' && ++lists === 3
      ? { code: 1, stdout: '', stderr: 'cannot read registrations' }
      : real(...args);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.ok((await git(['branch', '--list', branch])).includes(branch));
  });
});

test('cleanup preserves an unrelated missing worktree registration', async () => {
  await fixture(async ({ repo, worktree, branch, deps, calls, git }) => {
    const other = path.join(repo, 'temporarily-offline');
    await git(['worktree', 'add', '-b', 'user/offline', other]);
    await guardedRemoveFixture(repo, other);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), true);
    assert.match(await git(['worktree', 'list', '--porcelain']), /refs\/heads\/user\/offline/);
    assert.ok(!calls.some((args) => args[1] === 'prune'));
  });
});

test('cleanup preserves a nested registered checkout before killing terminals', async () => {
  await fixture(async ({ repo, worktree, branch, deps, kills, git }) => {
    const nested = path.join(worktree, 'nested');
    await git(['worktree', 'add', '-b', 'user/nested', nested]);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.deepEqual(kills, []);
    assert.ok((await fs.lstat(nested)).isDirectory());
  });
});

test('a checkout locked during terminal shutdown is preserved', async () => {
  await fixture(async ({ repo, worktree, branch, deps, calls, git }) => {
    deps.proxyKillSessionsByCwd = async () => {
      await git(['worktree', 'lock', worktree]);
    };
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.ok(!calls.some((args) => args[1] === 'remove'));
    assert.ok((await fs.lstat(worktree)).isDirectory());
  });
});

test('a reported successful removal with a leftover directory preserves the branch', async () => {
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    const real = deps.projectGit;
    deps.projectGit = async (...args) => args[1][1] === 'remove'
      ? { code: 0, stdout: '', stderr: '' }
      : real(...args);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), false);
    assert.ok((await git(['branch', '--list', branch])).includes(branch));
  });
});

test('permission errors inspecting an unregistered path never count as an absent checkout', async (t) => {
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    await git(['worktree', 'remove', '--force', worktree]);
    const lstat = fs.lstat;
    t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === worktree) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return lstat(...args);
    });
    await assert.rejects(cleanupWorktreeForTask(repo, worktree, branch, deps), { code: 'EACCES' });
    assert.ok((await git(['branch', '--list', branch])).includes(branch));
  });
});

// keepBranchIfUnmerged (task delete): the worktree goes, but a branch with
// commits not in HEAD is the only copy of that work and is kept.
async function commitInWorktree(worktree: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-qm', `work ${i}`], worktree);
    assert.equal(r.code, 0, r.stderr);
  }
}

test('keepBranchIfUnmerged removes the worktree but keeps a branch with unmerged commits', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  await fixture(async ({ repo, worktree, branch, deps, calls, git }) => {
    await commitInWorktree(worktree, 3);
    const kept: unknown[] = [];
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps, {
      keepBranchIfUnmerged: true, onBranchKept: (info) => kept.push(info),
    }), true);
    await assert.rejects(fs.lstat(worktree), { code: 'ENOENT' });
    assert.ok((await git(['branch', '--list', branch])).includes(branch));
    assert.deepEqual(kept, [{ name: branch, unmergedCommits: 3 }]);
    assert.ok(!calls.some((args) => args[0] === 'branch' && args[1] === '-D'));
  });
});

test('keepBranchIfUnmerged still deletes a branch with no commits beyond HEAD', async () => {
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    const kept: unknown[] = [];
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps, {
      keepBranchIfUnmerged: true, onBranchKept: (info) => kept.push(info),
    }), true);
    assert.equal((await git(['branch', '--list', branch])).trim(), '');
    assert.deepEqual(kept, []);
  });
});

test('keepBranchIfUnmerged keeps the branch when the unmerged count cannot be determined', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    const real = deps.projectGit;
    deps.projectGit = async (...args) => args[1][0] === 'rev-list'
      ? { code: 128, stdout: '', stderr: 'fatal: bad revision' }
      : real(...args);
    const kept: unknown[] = [];
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps, {
      keepBranchIfUnmerged: true, onBranchKept: (info) => kept.push(info),
    }), true);
    assert.ok((await git(['branch', '--list', branch])).includes(branch));
    assert.deepEqual(kept, [{ name: branch, unmergedCommits: null }]);
  });
});

test('without keepBranchIfUnmerged a branch with unmerged commits is still deleted (finalize path)', async () => {
  await fixture(async ({ repo, worktree, branch, deps, git }) => {
    await commitInWorktree(worktree, 1);
    assert.equal(await cleanupWorktreeForTask(repo, worktree, branch, deps), true);
    assert.equal((await git(['branch', '--list', branch])).trim(), '');
  });
});

test('task delete payload carries an actionable hint for a kept branch', () => {
  const p = keptBranchPayload({ name: 'lattice/foo-ab12', unmergedCommits: 3 });
  assert.equal(p.name, 'lattice/foo-ab12');
  assert.equal(p.unmergedCommits, 3);
  assert.equal(p.hint,
    'kept branch lattice/foo-ab12: 3 unmerged commit(s). Merge it, or run ' +
    '`git branch -D lattice/foo-ab12` to discard.');
  assert.match(keptBranchPayload({ name: 'lattice/x-1', unmergedCommits: null }).hint,
    /could not be determined.*git branch -D lattice\/x-1/);
});
