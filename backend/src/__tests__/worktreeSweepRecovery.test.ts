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
  const deps: WorktreeSweepDeps = {
    forEachKnownProjectSafely: async (_label, fn) => {
      try { await fn(project); } catch (err) { errors.push(err); }
    },
    listTasks: async () => [{ id: 'historical-task', status: 'qa' } as Task],
    gitDirExists: async () => true,
    projectGit: async () => ({
      code: 0, stderr: '',
      stdout: `worktree ${project}\nbranch refs/heads/main\n\nworktree ${worktree}\nbranch refs/heads/lattice/task-abc\n`,
    }),
    cleanupWorktreeForTask: async (_project, dir) => { removed.push(dir); return true; },
    collectLiveSessionCwds: async () => new Set(),
    ...overrides,
  };
  return { deps, removed, errors };
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
