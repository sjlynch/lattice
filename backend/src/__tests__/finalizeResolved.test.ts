import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { finalizeResolvedTask } from '../routes/tasks/finalizeResolved.js';
import { tryAcquire, release, isLocked } from '../mergeLocks.js';
import type { Task } from '../tasks.js';

const ORIGIN = 'http://127.0.0.1:5184';

// A clean conflict-flagged task whose branch/worktree exist on record but
// point at a non-existent dir, so the git finalize path (isMidMerge →
// resyncWithMainAndFinalize) fails fast on a missing cwd without touching any
// real repo. We only care about WHICH callers reach git, not the git result.
function makeResolverTask(suffix: string): Task {
  const id = `t_finalize_resolved_${suffix}`;
  const base = path.join(os.tmpdir(), `lattice-finalize-test-${suffix}`);
  return {
    id,
    projectPath: path.join(base, 'repo'),
    title: 'resolver finalize race fixture',
    status: 'ready_to_merge',
    conflict: true,
    branch: `lattice/${id}`,
    worktreePath: path.join(base, 'wt'),
    createdAt: 0,
  };
}

test('finalizeResolvedTask backs off when the per-task merge lock is held', async () => {
  const task = makeResolverTask(`held_${Date.now()}`);

  // Simulate the merge-run worker (processTarget / tryFinalizeAfterResolver-
  // Finished) — or a concurrent /complete fire — already holding the lock and
  // running mergeWorktreeInRepo in the worktree.
  assert.equal(tryAcquire(task.id), true);
  try {
    const result = await finalizeResolvedTask(task, ORIGIN, 'complete');
    // It must NOT run a second git merge in the same worktree; it reports the
    // idempotent "someone else is finalizing" outcome instead.
    assert.deepEqual(result, { kind: 'already-finalizing' });
    // And it must not have released the lock it never acquired.
    assert.equal(isLocked(task.id), true);
  } finally {
    release(task.id);
  }
  assert.equal(isLocked(task.id), false);
});

test('two concurrent finalizeResolvedTask calls serialize — only one runs git', async () => {
  const task = makeResolverTask(`concurrent_${Date.now()}`);

  // Fire /complete twice concurrently for the same clean conflict-flagged
  // task. Before the fix both ran resyncWithMainAndFinalize → mergeWorktree-
  // InRepo in the one worktree, racing on .git/index.lock + MERGE_HEAD.
  const settled = await Promise.allSettled([
    finalizeResolvedTask(task, ORIGIN, 'complete'),
    finalizeResolvedTask(task, ORIGIN, 'complete'),
  ]);

  const backedOff = settled.filter(
    (r) => r.status === 'fulfilled' && r.value.kind === 'already-finalizing',
  );
  // Exactly one caller backed off on the lock; the other proceeded into the
  // single git finalize path (its result/throw is the bogus-path git failure).
  assert.equal(backedOff.length, 1);

  // No stuck per-task lock once both have settled.
  assert.equal(isLocked(task.id), false);
});

test('finalizeResolvedTask validates branch/worktree before acquiring the lock', async () => {
  const task = makeResolverTask(`noworktree_${Date.now()}`);
  delete task.branch;
  delete task.worktreePath;

  const result = await finalizeResolvedTask(task, ORIGIN, 'complete');
  assert.equal(result.kind, 'error');
  // A malformed task returns before tryAcquire, so it can never leak the lock.
  assert.equal(isLocked(task.id), false);
});
