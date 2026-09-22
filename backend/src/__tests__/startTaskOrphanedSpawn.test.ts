import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discardOrphanedSpawn } from '../routes/tasks/startTask.js';

// Regression for the delete-during-admitted-run orphan: a task deleted between
// the spawn queue admitting its run and startTaskById's in_progress flip had
// no `worktreePath` yet, so DELETE cleaned nothing up, `updateTask` returned
// null, and startTaskById still returned the spawn — runSpawnThunk then
// emitted `task-spawned` for a task that no longer existed and the worktree +
// pty lived on until the next boot's sweep. startTaskById now throws after
// tearing both down through this helper. The full function needs the real
// git/worktree/terminal-server stack, so the teardown is pinned at its seam.

const task = { id: 't1', projectPath: 'C:\\development\\proj' };
const worktree = { worktreePath: 'C:\\wt\\t1', branch: 'lattice/t1' };

test('discardOrphanedSpawn kills the pre-spawned pty first, then reclaims the worktree', async () => {
  const calls: string[] = [];
  const cleanupArgs: unknown[][] = [];
  await discardOrphanedSpawn(task, worktree, 'srv-1', {
    killSession: async (id) => { calls.push(`kill:${id}`); return true; },
    cleanupWorktree: async (...args: unknown[]) => { calls.push('cleanup'); cleanupArgs.push(args); return true; },
  });
  assert.deepEqual(calls, ['kill:srv-1', 'cleanup']);
  assert.deepEqual(cleanupArgs, [[task.projectPath, worktree.worktreePath, worktree.branch]]);
});

test('discardOrphanedSpawn skips the pty kill when no pty was spawned', async () => {
  const calls: string[] = [];
  await discardOrphanedSpawn(task, worktree, undefined, {
    killSession: async () => { calls.push('kill'); return true; },
    cleanupWorktree: async () => { calls.push('cleanup'); return true; },
  });
  assert.deepEqual(calls, ['cleanup']);
});

test('discardOrphanedSpawn is best-effort: a failing kill or cleanup never masks the caller\'s error', async () => {
  const calls: string[] = [];
  await discardOrphanedSpawn(task, worktree, 'srv-1', {
    killSession: async () => { calls.push('kill'); throw new Error('terminal-server down'); },
    cleanupWorktree: async () => { calls.push('cleanup'); throw new Error('EBUSY'); },
  });
  // Both were still attempted, and neither threw out.
  assert.deepEqual(calls, ['kill', 'cleanup']);
});
