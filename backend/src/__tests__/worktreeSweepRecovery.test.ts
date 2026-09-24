import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { homeWorktreesDir } from '../projectPath.js';
import { normalizeCwd } from '../recovery/liveSessions.js';
import { sweepOrphanedWorktrees, type WorktreeSweepDeps } from '../recovery/worktreeSweep.js';
import { listTasks, type Task } from '../tasks.js';
import { projectTasksFile } from '../taskCache/paths.js';

const project = path.resolve('worktree-sweep-fixture');
const worktree = path.join(homeWorktreesDir(project), 'task-abc');

function fixture(overrides: Partial<WorktreeSweepDeps> = {}) {
  const removed: string[] = [];
  const errors: unknown[] = [];
  const cleanupOpts: Array<Record<string, unknown>> = [];
  const deps: WorktreeSweepDeps = {
    forEachKnownProjectSafely: async (_label, fn) => {
      try { await fn(project); } catch (err) { errors.push(err); }
    },
    listTasks: async () => [{ id: 'historical-task', status: 'qa' } as Task],
    gitDirExists: async () => true,
    projectGit: async (_project, args) => args[0] === 'rev-list'
      ? { code: 0, stderr: '', stdout: '0\n' } // the orphan's branch is fully merged
      : args[0] === 'for-each-ref'
      ? { code: 0, stderr: '', stdout: '' } // no lattice/* branch has unmerged commits
      : {
        code: 0, stderr: '',
        stdout: `worktree ${project}\nbranch refs/heads/main\n\nworktree ${worktree}\nbranch refs/heads/lattice/task-abc\n`,
      },
    cleanupWorktreeForTask: async (_project, dir, _branch, _deps, opts) => {
      removed.push(dir);
      cleanupOpts.push(opts ?? {});
      return true;
    },
    collectLiveSessionCwds: async () => new Set(),
    ...overrides,
  };
  return { deps, removed, errors, cleanupOpts };
}

test('orphan worktree sweep preserves every checkout when task inventory fails', async () => {
  const readError = new Error('task database is temporarily locked');
  const { deps, removed, errors } = fixture({ listTasks: async () => { throw readError; } });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
  assert.deepEqual(errors, [readError]);
});

test('orphan worktree sweep preserves checkouts when PTY inventory is unavailable', async () => {
  const { deps, removed } = fixture({ collectLiveSessionCwds: async () => null });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
});

test('orphan worktree sweep preserves checkouts when a corrupt or missing task database loads empty', async () => {
  const { deps, removed } = fixture({ listTasks: async () => [] });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
});

test('an actual corrupt task database cannot make the recovery sweep remove its worktrees', async () => {
  // The test runner redirects HOME before imports; these are isolated store
  // bytes, and worktree deletion is still a recording stub.
  const file = projectTasksFile(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '[{"id":"valuable-task",', 'utf8');
  const { deps, removed } = fixture({ listTasks });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
  const files = await fs.readdir(path.dirname(file));
  assert.ok(files.some((name) => name.startsWith('tasks.json.corrupt-')),
    'the broken ownership bytes remain available for recovery');
});

test('orphan worktree sweep preserves a surviving PTY in a checkout subdirectory', async () => {
  const { deps, removed } = fixture({
    collectLiveSessionCwds: async () => new Set([normalizeCwd(path.join(worktree, 'backend'))]),
  });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
});

test('orphan worktree sweep compares task paths case-insensitively on Windows', {
  skip: process.platform !== 'win32',
}, async () => {
  const { deps, removed } = fixture({
    listTasks: async () => [{ status: 'in_progress', worktreePath: worktree.toUpperCase() } as Task],
  });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
});

test('orphan worktree sweep preserves an interrupted queued task checkout', async () => {
  const { deps, removed } = fixture({
    listTasks: async () => [{ status: 'open', runQueued: true, worktreePath: worktree } as Task],
  });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
});

test('orphan worktree sweep still reclaims a checkout with no task or live PTY', async () => {
  const { deps, removed } = fixture();
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, [worktree]);
});

// Unmerged commits on a lattice/* branch are the only copy of that work, so the
// branch is never deleted — but the checkout (gigabytes) is. A machine updated
// from an old version had 1000+ such orphans, each refused with an error line
// and a git call before the backend could listen (2026-09-24).
function unmergedListing(list: WorktreeSweepDeps['projectGit']): WorktreeSweepDeps['projectGit'] {
  return async (project, args, opts) => args[0] === 'for-each-ref'
    ? { code: 0, stderr: '', stdout: 'refs/heads/lattice/task-abc\n' }
    : list(project, args, opts);
}

test('an orphan whose branch has unmerged commits loses its checkout but keeps its branch', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
  const base = fixture();
  const { deps, removed, cleanupOpts } = fixture({ projectGit: unmergedListing(base.deps.projectGit) });
  const real = deps.cleanupWorktreeForTask;
  deps.cleanupWorktreeForTask = async (project, dir, branch, d, opts) => {
    opts?.onBranchKept?.({ name: branch, unmergedCommits: 2 });
    return real(project, dir, branch, d, opts);
  };
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, [worktree]);
  assert.equal(cleanupOpts[0]?.keepBranchIfUnmerged, true);
  assert.ok(warnings.some((w) => /KEPT their lattice\/\* branches.*lattice\/task-abc/.test(w)), warnings.join('\n'));
});

test('an Open task\'s checkout whose branch has unmerged commits is left alone', async () => {
  const base = fixture();
  const { deps, removed } = fixture({
    projectGit: unmergedListing(base.deps.projectGit),
    listTasks: async () => [{ id: 't', status: 'open', worktreePath: worktree } as Task],
  });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
});

test('the unmerged check is one git call for the whole project, not one per branch', async () => {
  const many = Array.from({ length: 50 }, (_, i) => path.join(homeWorktreesDir(project), `task-${i}`));
  const calls: string[] = [];
  const { deps, removed } = fixture({
    projectGit: async (_p, args) => {
      calls.push(args[0]);
      if (args[0] === 'for-each-ref') return { code: 0, stderr: '', stdout: '' };
      return {
        code: 0, stderr: '',
        stdout: `worktree ${project}\nbranch refs/heads/main\n\n` +
          many.map((w, i) => `worktree ${w}\nbranch refs/heads/lattice/task-${i}\n`).join('\n'),
      };
    },
  });
  await sweepOrphanedWorktrees(deps);
  assert.equal(removed.length, 50);
  assert.equal(calls.filter((c) => c === 'for-each-ref').length, 1);
  assert.equal(calls.filter((c) => c === 'rev-list').length, 0);
});

test('a branch whose state cannot be read still keeps its branch (checked one by one, fails closed)', async () => {
  const list = fixture().deps.projectGit;
  const { deps, removed, cleanupOpts } = fixture({
    projectGit: async (project, args, opts) => args[0] === 'rev-list' || args[0] === 'for-each-ref'
      ? { code: 128, stderr: 'fatal: bad revision', stdout: '' }
      : list(project, args, opts),
    listTasks: async () => [{ id: 't', status: 'backlog', worktreePath: worktree } as Task],
  });
  await sweepOrphanedWorktrees(deps);
  // Unknown counts as unmerged: a Backlog task's checkout is left alone …
  assert.deepEqual(removed, []);
  // … and an unowned one is reclaimed with the branch kept.
  const unowned = fixture({ projectGit: deps.projectGit });
  await sweepOrphanedWorktrees(unowned.deps);
  assert.deepEqual(unowned.removed, [worktree]);
  assert.equal(unowned.cleanupOpts[0]?.keepBranchIfUnmerged, true);
  assert.equal(cleanupOpts.length, 0);
});

test('orphan worktree sweep honors an explicit Git worktree lock', async () => {
  const { deps, removed } = fixture({
    projectGit: async () => ({ code: 0, stderr: '', stdout:
      `worktree ${project}\0branch refs/heads/main\0\0` +
      `worktree ${worktree}\0branch refs/heads/lattice/task-abc\0locked keep for recovery\0\0`,
    }),
  });
  await sweepOrphanedWorktrees(deps);
  assert.deepEqual(removed, []);
});

test('orphan worktree sweep does not report deferred cleanup as reclaimed', async (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => messages.push(args.join(' ')));
  const { deps } = fixture({ cleanupWorktreeForTask: async () => false });
  await sweepOrphanedWorktrees(deps);
  assert.ok(!messages.some((message) => message.includes('reclaimed')));
});

test('orphan worktree sweep does not globally prune skipped registrations', async () => {
  const calls: string[][] = [];
  const { deps } = fixture();
  const real = deps.projectGit;
  deps.projectGit = async (...args) => { calls.push(args[1]); return real(...args); };
  await sweepOrphanedWorktrees(deps);
  assert.ok(!calls.some((args) => args[1] === 'prune'));
});
