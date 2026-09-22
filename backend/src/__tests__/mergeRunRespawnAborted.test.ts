import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tryRespawnMidMergeResolver, type RespawnMidMergeDeps } from '../mergeRuns/flaggedConflict.js';
import { createRunState, type MergeRun, type MergeRunEvent } from '../mergeRuns/state.js';
import type { Task } from '../tasks.js';

// The mid-merge re-spawn path (`tryRespawnMidMergeResolver`) parks lock-free,
// so while its resolver spawn sits in the spawn queue nothing stops a
// `/merge-aborted` (the Resolving-strip Cancel, a give-up resolver) from
// clearing `task.conflict` and aborting the worktree merge. The resolver that
// then comes up would be told to resolve a merge that no longer exists. After
// the spawn resolves the task is re-read; if it is no longer a conflict-flagged
// ready_to_merge task, the new session is killed and the abort honoured.

function fixture(taskAfterSpawn: Partial<Task> | null) {
  const projectPath = path.resolve('isolated-project');
  const worktreePath = path.resolve('isolated-worktree');
  const task = {
    id: 'task-respawn', projectPath, worktreePath, branch: 'lattice/task',
    conflict: true, title: 'task', createdAt: 1, status: 'ready_to_merge',
  } as Task;
  const run: MergeRun = {
    id: 'run-respawn', projectPath, status: 'running', startedAt: 1, total: 1,
    processed: 0, merged: [], conflicted: [], errored: [], cancelRequested: false,
  };
  const state = createRunState();
  const events: MergeRunEvent[] = [];
  state.emit = (event) => { events.push(event); }; // no persistence in a unit test
  const killed: string[] = [];
  const deps: RespawnMidMergeDeps = {
    respawn: async () => ({ kind: 'spawned', serverId: 'fresh-pty' }),
    getTask: async () => (taskAfterSpawn === null ? null : ({ ...task, ...taskAfterSpawn } as Task)),
    killSession: async (id) => { killed.push(id); return true; },
  };
  return { task, run, ctx: { state, projectPath, backendOrigin: 'http://unused', baselineHead: null }, deps, killed, state };
}

test('a conflict cleared while the re-spawn was queued kills the new resolver and records the abort', async () => {
  const f = fixture({ conflict: undefined });
  const outcome = await tryRespawnMidMergeResolver(f.task, f.run, f.ctx, f.deps);
  assert.equal(outcome.kind, 'errored');
  assert.deepEqual(f.killed, ['fresh-pty']);
  assert.equal(f.run.processed, 1);
  assert.match(f.run.errored[0]?.error ?? '', /aborted while its resolver re-spawn was queued/);
  // The waiter registered up front was abandoned, so a later signal is a no-op
  // rather than a release of some other run's waiter.
  assert.equal(f.state.signalConflictWaiter(f.task.id), false);
});

test('a task that left ready_to_merge while the re-spawn was queued is treated the same way', async () => {
  const f = fixture({ status: 'qa' });
  const outcome = await tryRespawnMidMergeResolver(f.task, f.run, f.ctx, f.deps);
  assert.equal(outcome.kind, 'errored');
  assert.deepEqual(f.killed, ['fresh-pty']);
});

test('a still-conflicted task keeps its re-spawned resolver and parks on the waiter', async () => {
  const f = fixture({ conflict: true });
  const pending = tryRespawnMidMergeResolver(f.task, f.run, f.ctx, f.deps);
  // The waiter is registered synchronously; release it as a real /complete
  // would so the park returns 'signalled' (the liveness probe's first poll
  // is 30 s out and is cleared on finish).
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.state.signalConflictWaiter(f.task.id), true);
  const outcome = await pending;
  assert.equal(outcome.kind, 'awaiting-resolver');
  assert.deepEqual(f.killed, []);
  assert.deepEqual(f.run.errored, []);
});
