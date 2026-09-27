import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Response } from 'express';
import { handleAlreadyConflictedMerge } from '../routes/tasks/manualMergeService.js';
import type { MergeReadyTask } from '../routes/tasks/manualMergeTypes.js';

// Re-clicking a conflicted task's "conflict" pill / Merge while its resolver
// is still working used to spawn a SECOND resolver pty into the same worktree
// (the `mm-resolver:` spawn-queue dedupe only covers a still-queued request).
// The already-conflicted manual /merge must hand back the live resolver.

const worktreePath = path.resolve('isolated-manual-worktree');
const task = {
  id: 'task-manual', title: 'task', projectPath: path.resolve('isolated-project'), status: 'ready_to_merge',
  createdAt: 1, branch: 'lattice/task', worktreePath, conflict: true,
} as MergeReadyTask;
const res = {} as Response;

function deps(sessions: unknown[] | null) {
  const calls = { spawned: 0, reused: [] as string[] };
  return {
    calls,
    deps: {
      isMidMerge: async () => true,
      listSessions: async () => sessions,
      respondExistingConflictInstructions: async () => { calls.spawned += 1; return res; },
      respondLiveResolver: async (_res: Response, _task: MergeReadyTask, serverId: string) => {
        calls.reused.push(serverId);
        return res;
      },
    } as unknown as NonNullable<Parameters<typeof handleAlreadyConflictedMerge>[3]>,
  };
}

test('a conflicted manual merge reuses the resolver already running in the worktree', async () => {
  const f = deps([{ id: 'live-resolver', cwd: worktreePath, initialCommand: 'claude "Please read MERGE_INSTRUCTIONS.md and follow the steps to resolve the merge conflict."' }]);
  await handleAlreadyConflictedMerge(task, 'http://unused', res, f.deps);
  assert.deepEqual(f.calls.reused, ['live-resolver']);
  assert.equal(f.calls.spawned, 0, 'two resolvers would edit and commit the same merge');
});

test('a conflicted manual merge spawns a resolver when none is running there', async () => {
  const f = deps([
    { id: 'task-agent', cwd: worktreePath, initialCommand: 'claude "Please read LATTICE_TASK.md"' },
    { id: 'elsewhere', cwd: path.resolve('another-worktree'), initialCommand: 'claude "Please read MERGE_INSTRUCTIONS.md"' },
  ]);
  await handleAlreadyConflictedMerge(task, 'http://unused', res, f.deps);
  assert.equal(f.calls.spawned, 1);
  assert.deepEqual(f.calls.reused, []);
});

test('an unreachable terminal-server falls through to the normal spawn path', async () => {
  const f = deps(null);
  await handleAlreadyConflictedMerge(task, 'http://unused', res, f.deps);
  assert.equal(f.calls.spawned, 1);
});
