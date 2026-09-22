import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../worktree/exec.js';
import { projectGit } from '../worktree/projectGit.js';
import { reconcileStaleState } from '../worktree/reconcile.js';
import { parseWorktreesPorcelain } from '../worktree/state.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';
import { fsRmWithRetries } from '../worktree/rmRetry.js';
import { homeWorktreesDir } from '../projectPath.js';
import { withTempDir } from './helpers/tempDir.js';

const branch = 'lattice/reconcile-test';
type Overrides = NonNullable<Parameters<typeof reconcileStaleState>[3]>;

async function git(repo: string, args: string[]): Promise<string> {
  const result = await exec('git', args, repo, { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function withRepo(fn: (repo: string, candidate: string, root: string) => Promise<void>): Promise<void> {
  // This suite owns home-scoped candidates, so refusing a missing preload is
  // safer than silently creating fixtures alongside actual user worktrees.
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  await withTempDir('lattice-reconcile-real-', async (root) => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice-test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial']);
    const base = homeWorktreesDir(repo);
    const candidate = path.join(base, 'task-candidate');
    await fs.mkdir(base, { recursive: true });
    try {
      await fn(repo, candidate, root);
    } finally {
      assert.ok(path.resolve(base).startsWith(path.resolve(os.homedir()) + path.sep));
      await fs.rm(base, { recursive: true, force: true });
    }
  });
}

function observed(overrides: Overrides = {}) {
  const effects: string[] = [];
  const commands: string[][] = [];
  const deps: Overrides = {
    projectGit: async (repo, args, options) => {
      commands.push(args);
      if (args[0] === 'branch' || args[1] === 'remove' || args[1] === 'prune') effects.push(args.join(' '));
      return (overrides.projectGit ?? projectGit)(repo, args, options);
    },
    killSessions: async (cwd) => { effects.push(`kill ${cwd}`); },
    waitForHandles: overrides.waitForHandles ?? (async () => {}),
    pruneReparsePoints: async (cwd) => {
      effects.push(`links ${cwd}`);
      return pruneReparsePointsUnder(cwd);
    },
    removeStray: async (cwd, options) => {
      effects.push(`raw ${cwd}`);
      return fsRmWithRetries(cwd, options);
    },
  };
  return { deps, effects, commands };
}

async function registered(repo: string) {
  return parseWorktreesPorcelain(await git(repo, ['worktree', 'list', '--porcelain', '-z']));
}

async function assertBranchPresent(repo: string): Promise<void> {
  await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
}

test('reconcile preserves the same branch at an external worktree or in main before any side effects', async () => {
  for (const location of ['external', 'main']) {
    await withRepo(async (repo, candidate, root) => {
      const target = location === 'main' ? repo : path.join(root, 'external');
      if (location === 'main') await git(repo, ['checkout', '-q', '-b', branch]);
      else await git(repo, ['worktree', 'add', '-q', '-b', branch, target]);
      await fs.writeFile(path.join(target, 'keep.txt'), 'preserved');
      const { deps, effects } = observed();
      assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
      assert.deepEqual(effects, []);
      assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'preserved');
      await assertBranchPresent(repo);
    });
  }
});

test('reconcile preserves a worktree moved to another managed path', async () => {
  await withRepo(async (repo, candidate) => {
    const moved = `${candidate}-moved`;
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await git(repo, ['worktree', 'move', candidate, moved]);
    const { deps, effects } = observed();
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, []);
    assert.ok((await registered(repo)).some((entry) => path.resolve(entry.path) === moved));
  });
});

test('reconcile preserves locked present and missing worktrees without killing PTYs or pruning links', async () => {
  for (const missing of [false, true]) {
    await withRepo(async (repo, candidate, root) => {
      await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
      await git(repo, ['worktree', 'lock', '--reason', 'keep for recovery', candidate]);
      if (missing) await fs.rename(candidate, path.join(root, 'offline'));
      const { deps, effects } = observed();
      assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
      assert.deepEqual(effects, []);
      assert.equal((await registered(repo)).find((entry) => entry.branch === `refs/heads/${branch}`)?.locked, true);
      await assertBranchPresent(repo);
    });
  }
});

test('reconcile preserves a candidate registered on another branch or detached', async () => {
  for (const detached of [false, true]) {
    await withRepo(async (repo, candidate) => {
      await git(repo, ['worktree', 'add', '-q', ...(detached ? ['--detach'] : ['-b', 'lattice/other']), candidate]);
      const { deps, effects } = observed();
      assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
      assert.deepEqual(effects, []);
      assert.equal((await registered(repo)).length, 2);
    });
  }
});

test('reconcile fails closed on failed or empty worktree inventory before touching a stray', async () => {
  for (const result of [{ code: 128, stdout: '', stderr: 'injected inventory failure' }, { code: 0, stdout: '', stderr: '' }]) {
    await withRepo(async (repo, candidate) => {
      await fs.mkdir(candidate);
      await fs.writeFile(path.join(candidate, 'keep.txt'), 'preserved');
      const { deps, effects } = observed({
        projectGit: async (cwd, args, options) => args[1] === 'list' ? result : projectGit(cwd, args, options),
      });
      await assert.rejects(reconcileStaleState(repo, branch, candidate, deps), /worktree list/);
      assert.deepEqual(effects, []);
      assert.equal(await fs.readFile(path.join(candidate, 'keep.txt'), 'utf8'), 'preserved');
    });
  }
});

test('reconcile distinguishes a failed branch lookup from a missing branch', async () => {
  await withRepo(async (repo, candidate) => {
    await fs.mkdir(candidate);
    const { deps, effects } = observed({
      projectGit: async (cwd, args, options) => args[0] === 'rev-parse'
        ? { code: 128, stdout: '', stderr: 'injected branch failure' }
        : projectGit(cwd, args, options),
    });
    await assert.rejects(reconcileStaleState(repo, branch, candidate, deps), /branch lookup failed/);
    assert.deepEqual(effects, []);
    assert.ok((await fs.stat(candidate)).isDirectory());
  });
});

test('reconcile never raw-deletes a registered worktree or branch when Git removal fails', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'keep.txt'), 'preserved');
    const { deps, effects, commands } = observed({
      projectGit: async (cwd, args, options) => args[1] === 'remove'
        ? { code: 255, stdout: '', stderr: 'injected Windows directory lock' }
        : projectGit(cwd, args, options),
    });
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.ok(!effects.some((effect) => effect.startsWith('raw ')));
    assert.ok(!commands.some((args) => args[0] === 'branch' || args[1] === 'prune'));
    assert.equal(await fs.readFile(path.join(candidate, 'keep.txt'), 'utf8'), 'preserved');
    assert.equal((await registered(repo)).length, 2);
    await assertBranchPresent(repo);
  });
});

test('reconcile removes only the exact unlocked candidate and preserves unrelated missing registrations', async () => {
  await withRepo(async (repo, candidate, root) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    const other = path.join(root, 'unrelated');
    await git(repo, ['worktree', 'add', '-q', '-b', 'user/offline', other]);
    await fs.rename(other, path.join(root, 'offline'));
    const { deps, effects, commands } = observed();
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), true);
    await assert.rejects(fs.stat(candidate), { code: 'ENOENT' });
    assert.equal((await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)).code, 1);
    assert.ok((await registered(repo)).some((entry) => entry.branch === 'refs/heads/user/offline'));
    assert.ok(!effects.some((effect) => effect.startsWith('raw ')));
    assert.ok(!commands.some((args) => args[1] === 'prune'));
    assert.ok(commands.filter((args) => args[1] === 'list').every((args) => args.includes('-z')));
  });
});

test('reconcile unregisters an exact missing unlocked candidate through Git without global prune', async () => {
  await withRepo(async (repo, candidate, root) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.rename(candidate, path.join(root, 'offline'));
    const { deps, effects } = observed();
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), true);
    assert.equal((await registered(repo)).length, 1);
    assert.ok(!effects.some((effect) => /^(kill|links|raw) /.test(effect)));
  });
});

test('reconcile clears an unregistered home stray but preserves an unregistered .git marker', async () => {
  for (const marker of [false, true]) {
    await withRepo(async (repo, candidate) => {
      await fs.mkdir(candidate);
      await fs.writeFile(path.join(candidate, marker ? '.git' : 'stale.txt'), 'preserved');
      const { deps, effects } = observed();
      assert.equal(await reconcileStaleState(repo, branch, candidate, deps), !marker);
      if (marker) {
        assert.deepEqual(effects, []);
        assert.equal(await fs.readFile(path.join(candidate, '.git'), 'utf8'), 'preserved');
      } else {
        assert.ok(effects.some((effect) => effect.startsWith('raw ')));
        await assert.rejects(fs.stat(candidate), { code: 'ENOENT' });
      }
    });
  }
});

test('reconcile refuses a junction candidate before PTY or child-link mutation', async () => {
  await withRepo(async (repo, candidate, root) => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'preserved');
    await fs.symlink(outside, candidate, process.platform === 'win32' ? 'junction' : 'dir');
    const { deps, effects, commands } = observed();
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, []);
    assert.deepEqual(commands, []);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'preserved');
  });
});

test('reconcile rechecks a new Git lock after waiting for PTYs before pruning or removal', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    const { deps, effects } = observed({ waitForHandles: async () => {
      await git(repo, ['worktree', 'lock', candidate]);
    } });
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, [`kill ${candidate}`]);
    assert.equal((await registered(repo)).find((entry) => entry.branch === `refs/heads/${branch}`)?.locked, true);
  });
});

test('reconcile refuses raw cleanup if an initially unregistered path becomes a worktree while waiting', async () => {
  await withRepo(async (repo, candidate) => {
    await fs.mkdir(candidate);
    const { deps, effects } = observed({ waitForHandles: async () => {
      await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    } });
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, [`kill ${candidate}`]);
    assert.equal((await registered(repo)).length, 2);
    await assertBranchPresent(repo);
  });
});

test('reconcile preserves registered worktrees nested under an unregistered candidate', async () => {
  await withRepo(async (repo, candidate) => {
    await fs.mkdir(candidate);
    await git(repo, ['worktree', 'add', '-q', '-b', 'user/nested', path.join(candidate, 'nested')]);
    const { deps, effects } = observed();
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, []);
    assert.equal((await registered(repo)).length, 2);
  });
});

test('reconcile refuses to clear a candidate whose branch has unmerged commits (no mutation at all)', async (t) => {
  // "Move to Open" from in_progress / ready_to_merge keeps task.branch, so a
  // fresh ▶ Run reconciles the very branch that carries the previous run's
  // commits. Clearing it would `branch -D` the only copy of that work.
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'work.txt'), 'unmerged work');
    await git(candidate, ['add', '-A']);
    await git(candidate, ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice-test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'unmerged']);
    const { deps, effects } = observed();
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, [], 'no kill / remove / branch delete may run');
    assert.equal(await fs.readFile(path.join(candidate, 'work.txt'), 'utf8'), 'unmerged work');
    assert.ok((await registered(repo)).some((entry) => entry.branch === `refs/heads/${branch}`));
    await assertBranchPresent(repo);
    assert.ok(errors.some((e) => e.includes(branch) && /1 unmerged commit/.test(e)), errors.join('\n'));
  });
});

test('reconcile keeps the branch when the previous agent commits while its PTY is being released', async (t) => {
  // The unmerged-commit count used to run only BEFORE the PTY kill + wait +
  // archive; a commit landing in that window was then dropped by `branch -D`.
  t.mock.method(console, 'error', () => {});
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    const { deps, effects } = observed({ waitForHandles: async () => {
      await fs.writeFile(path.join(candidate, 'late.txt'), 'late work');
      await git(candidate, ['add', '-A']);
      await git(candidate, ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice-test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'late']);
    } });
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.ok(!effects.some((e) => e.startsWith('branch -D')), effects.join('\n'));
    await assertBranchPresent(repo);
    assert.equal((await git(repo, ['rev-list', '--count', `main..${branch}`])).trim(), '1');
  });
});

test('reconcile preserves a stray-looking candidate nested inside another registered worktree', async () => {
  await withRepo(async (repo, parent) => {
    await git(repo, ['worktree', 'add', '-q', '-b', 'user/parent', parent]);
    const candidate = path.join(parent, 'scratch');
    await fs.mkdir(candidate);
    await fs.writeFile(path.join(candidate, 'keep.txt'), 'preserved');
    const { deps, effects } = observed();
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, []);
    assert.equal(await fs.readFile(path.join(candidate, 'keep.txt'), 'utf8'), 'preserved');
  });
});
