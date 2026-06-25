// Shared "resolver-Claude finished — re-sync with main and finalize" flow
// used by both /api/tasks/:id/complete and /api/tasks/:id/merged. The two
// routes share the same git/state machine; only the HTTP shape (status codes
// + error message phrasing + per-source logging) differs, so this returns a
// route-friendly discriminated result and lets each caller render it.

import { isMidMerge, resyncWithMainAndFinalize } from '../../worktree.js';
import { signalConflictWaiter, startMergeRun } from '../../mergeRuns.js';
import { release, tryAcquire } from '../../mergeLocks.js';
import type { Task } from '../../tasks.js';

export type ResolverHookSource = 'complete' | 'merged';

export type FinalizeResolvedResult =
  | { kind: 'mid-merge' }
  | { kind: 'finalized' }
  | { kind: 'already-finalizing' }
  | {
      kind: 'merge-conflict';
      conflictedFiles: string[];
      command: string;
      cwd: string;
    }
  | { kind: 'error'; phase: 'merge' | 'finalize' | 'stash'; message: string };

function signalOrRestartMergeRun(task: Task, backendOrigin: string): void {
  if (!signalConflictWaiter(task.id)) {
    startMergeRun(task.projectPath, backendOrigin).catch(() => {});
  }
}

export async function finalizeResolvedTask(
  task: Task,
  backendOrigin: string,
  source: ResolverHookSource,
): Promise<FinalizeResolvedResult> {
  if (!task.branch || !task.worktreePath) {
    return {
      kind: 'error',
      phase: 'merge',
      message: 'task missing branch/worktree info',
    };
  }

  // Serialize against the merge-run worker (processTarget /
  // tryFinalizeAfterResolverFinished both take this same per-task lock) and
  // against a concurrent resolver-hook fire (two near-simultaneous /complete
  // curls, or /complete racing /merged) on the same per-task lock. Without
  // it, two resyncWithMainAndFinalize -> mergeWorktreeInRepo invocations race
  // on .git/index.lock + MERGE_HEAD in the one worktree and corrupt its
  // merge state. The hook callbacks are idempotent and retried, so a caller
  // that loses the race just reports 'already-finalizing'; the holder finishes
  // the work. (finalizeQueues only serializes the FF step, not this earlier
  // in-worktree merge — so the lock must be taken here.)
  if (!tryAcquire(task.id)) {
    if (source === 'complete') {
      console.log(
        `[complete] task ${task.id}: finalize already in progress (lock held) — skipping`,
      );
    }
    return { kind: 'already-finalizing' };
  }
  try {
    return await runFinalize(task, task.worktreePath, backendOrigin, source);
  } finally {
    release(task.id);
  }
}

// Lock-held body. Split out only so the acquire/release wrapper above stays
// readable; the validated worktree path is passed in so this never re-reads a
// possibly-undefined field.
async function runFinalize(
  task: Task,
  worktreePath: string,
  backendOrigin: string,
  source: ResolverHookSource,
): Promise<FinalizeResolvedResult> {
  if (await isMidMerge(worktreePath)) {
    if (source === 'complete') {
      // Resolver hasn't committed yet (Stop fired mid-resolution).
      console.log(
        `[complete] task ${task.id}: resolver still mid-merge, skipping FF.`,
      );
    }
    return { kind: 'mid-merge' };
  }

  // Re-sync with current main before finalizing. The merge run may have
  // advanced main (via other tasks) while the resolver was working, making
  // the branch's merge commit stale relative to main — causing --ff-only
  // to fail. Merging again absorbs those new main commits; if that also
  // conflicts we need another resolver pass. If main is already an ancestor
  // of the worktree branch, skip the re-sync.
  const outcome = await resyncWithMainAndFinalize(task, backendOrigin, {
    skipIfMainAncestor: true,
    onMainAlreadyIncorporated: () => {
      console.log(
        `[${source}] task ${task.id}: main already incorporated — skipping re-sync`,
      );
    },
  });

  if (outcome.kind === 'merge-conflict') {
    if (source === 'complete') {
      console.log(
        `[complete] task ${task.id}: re-sync with main conflicted — resolver re-queued`,
      );
    }
    // Unblock any waiting merge run so it can move on to the next task;
    // this task stays conflicted and will be picked up on the next merge-all.
    signalOrRestartMergeRun(task, backendOrigin);
    return {
      kind: 'merge-conflict',
      conflictedFiles: outcome.conflictedFiles,
      command: outcome.command,
      cwd: outcome.cwd,
    };
  }

  if (outcome.kind === 'error') {
    if (source === 'complete') {
      if (outcome.phase === 'merge') {
        console.warn(
          `[complete] task ${task.id}: re-sync with main failed: ${outcome.message}`,
        );
      } else {
        console.warn(
          `[complete] finalize after resolution failed: ${outcome.message}`,
        );
      }
    }
    return { kind: 'error', phase: outcome.phase, message: outcome.message };
  }

  if (outcome.kind === 'stash-conflict') {
    if (source === 'complete') {
      console.warn(
        `[complete] finalize after resolution failed: ${outcome.message}`,
      );
    }
    return { kind: 'error', phase: 'stash', message: outcome.message };
  }

  // Signal the in-process merge run that spawned this resolver so it can
  // continue to the next task with the updated main HEAD. If no run is
  // waiting (e.g. the run was killed by a backend restart), start a fresh
  // one to pick up any remaining ready_to_merge tasks.
  signalOrRestartMergeRun(task, backendOrigin);
  return { kind: 'finalized' };
}
