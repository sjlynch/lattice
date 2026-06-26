import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  finalizeResolvedTask,
  type FinalizeResolvedDeps,
} from '../routes/tasks/finalizeResolved.js';
import { ConflictWaiterRegistry } from '../mergeRuns/conflictWaiters.js';
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
  const lock = tryAcquire(task.id);
  assert.notEqual(lock, null);
  try {
    const result = await finalizeResolvedTask(task, ORIGIN, 'complete');
    // It must NOT run a second git merge in the same worktree; it reports the
    // idempotent "someone else is finalizing" outcome instead.
    assert.deepEqual(result, { kind: 'already-finalizing' });
    // And it must not have released the lock it never acquired.
    assert.equal(isLocked(task.id), true);
  } finally {
    release(lock!);
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

// Regression: a resolver /complete whose re-sync/finalize errors out (a git/FF
// failure, or assertGitDirIntact throwing because .git vanished) used to return
// WITHOUT signalling the merge-run's conflict waiter. That waiter has no
// timeout, so the merge-run worker stayed blocked forever — holding the
// cross-process project lock and 409-ing every later /merge and merge-run.
// Both the `error` and `stash-conflict` outcomes must now unblock the waiter,
// exactly as the `merge-conflict` branch already does.
//
// We inject deps so `resync` deterministically returns the failure outcome
// (the real git path throws for a throwaway worktree, and is environment-
// dependent) and `signalOrRestartMergeRun` drives a real ConflictWaiterRegistry
// — mirroring production's signalConflictWaiter -> registry.signal wiring —
// so the assertion is the literal "the waiting run's promise resolves".

// finalizeResolvedTask runs isMidMerge(worktreePath) before resync; on a
// non-existent dir that git spawn would ENOENT and throw, so the worktree dir
// must actually exist (a plain, non-git dir → git rev-parse fails → not
// mid-merge) for the stubbed resync to be reached.
async function withExistingWorktree(
  task: Task,
  fn: () => Promise<void>,
): Promise<void> {
  await fs.mkdir(task.worktreePath!, { recursive: true });
  try {
    await fn();
  } finally {
    await fs.rm(path.dirname(task.worktreePath!), {
      recursive: true,
      force: true,
    });
  }
}

// signalOrRestartMergeRun wired to a real waiter registry, exactly as
// production's does (signalConflictWaiter(task.id) -> registry.signal). Returns
// the registry so the test can register a waiter for the same task id.
function depsThatSignal(
  waiters: ConflictWaiterRegistry,
  resync: FinalizeResolvedDeps['resync'],
): FinalizeResolvedDeps {
  return {
    resync,
    signalOrRestartMergeRun: (t) => {
      waiters.signal(t.id);
    },
  };
}

async function assertResolvesQuickly(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), 1000),
  );
  const winner = await Promise.race([promise.then(() => 'resolved'), timeout]);
  assert.equal(winner, 'resolved', message);
}

test('finalizeResolvedTask signals the conflict waiter when finalize errors out', async () => {
  const task = makeResolverTask(`error_signal_${Date.now()}`);
  await withExistingWorktree(task, async () => {
    const waiters = new ConflictWaiterRegistry();
    const waiterPromise = waiters.register('run-fake', task.id);

    const deps = depsThatSignal(waiters, async () => ({
      kind: 'error',
      phase: 'finalize',
      message: 'simulated FF failure',
    }));

    const result = await finalizeResolvedTask(task, ORIGIN, 'complete', deps);
    assert.equal(result.kind, 'error');
    // Before the fix this never resolved — the merge run hung forever.
    await assertResolvesQuickly(
      waiterPromise,
      'error-out finalize must unblock the waiting merge run',
    );
    // The lock the call acquired is released even on the error path.
    assert.equal(isLocked(task.id), false);
  });
});

test('finalizeResolvedTask signals the conflict waiter on a stash-conflict', async () => {
  const task = makeResolverTask(`stash_signal_${Date.now()}`);
  await withExistingWorktree(task, async () => {
    const waiters = new ConflictWaiterRegistry();
    const waiterPromise = waiters.register('run-fake', task.id);

    const deps = depsThatSignal(waiters, async () => ({
      kind: 'stash-conflict',
      cwd: task.worktreePath!,
      resolveCommand: 'claude --resume',
      conflictedFiles: ['frontend/src/api.ts'],
      message: 'stash-pop conflict',
    }));

    const result = await finalizeResolvedTask(task, ORIGIN, 'complete', deps);
    assert.equal(result.kind, 'error');
    await assertResolvesQuickly(
      waiterPromise,
      'stash-conflict finalize must unblock the waiting merge run',
    );
    assert.equal(isLocked(task.id), false);
  });
});
