// POST /api/tasks/:id/merge-aborted — the resolver Claude gave up, OR the user
// clicked the Resolving-strip "Cancel" button to abandon a stuck resolution.
//
// We run `git merge --abort` ourselves if needed rather than trusting the
// resolver to have: MERGE_HEAD left set with conflict:false is the
// orphan-mid-merge state that wedges the next /merge (preflight also
// auto-recovers — belt + braces). Abort + conflict-clear + resolver-pty kill are
// shared with the merge-run liveness backstop (`recoverAbandonedResolverTask`).
//
// Clearing task.conflict is what makes a cancel authoritative: a late /merged
// (or Stop-hook /complete) from a still-running resolver is gated on it and
// becomes a no-op; the resolver pty is killed too. For the same reason we MUST
// `signalConflictWaiter`: a merge-run worker parked on this task's untimed
// conflict waiter (`registerConflictWaiter`) would otherwise await forever —
// never releasing the cross-process project run-lock and 409-ing every later
// /merge, merge run and workflow Merge step until a backend restart. The aborted
// task stays plain ready_to_merge for the next merge-all (unlike /complete and
// /merged, we deliberately do NOT restart a fresh run for it).

import type { Request, Response } from 'express';
import { getTask, type Task } from '../../../tasks.js';
import { signalConflictWaiter } from '../../../mergeRuns.js';
import { recoverAbandonedResolverTask } from '../../../mergeRuns/abandonedResolver.js';
import { acquireBriefly, release } from '../../../mergeLocks.js';
import { requireTaskInRequestedProject } from '../requestUtils.js';

// How long /merge-aborted polls for a held per-task merge lock before 409ing.
export const MERGE_ABORT_LOCK_WAIT_MS = 5_000;

// Injectable seam (production default below), mirroring finalizeResolved.ts: the
// regression test overrides these to register a real waiter on a throwaway run
// state and assert /merge-aborted releases it — without the merge-run singleton.
export type MergeAbortedDeps = {
  recover: (task: Task) => Promise<void>;
  signalConflictWaiter: (taskId: string) => boolean;
  // How long to wait for a held merge lock before 409ing (tests shorten it).
  lockWaitMs?: number;
};

const productionDeps: MergeAbortedDeps = {
  recover: recoverAbandonedResolverTask,
  signalConflictWaiter,
};

export function handleTaskMergeAborted(
  _backendOrigin: string,
  deps: MergeAbortedDeps = productionDeps,
) {
  return async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    // The board's Cancel button sends `?project=`; a task from another board
    // is a 404, like every other by-id route. No/empty project = unpinned, so
    // a resolver agent's give-up curl (which carries none) still works.
    if (!requireTaskInRequestedProject(task, req, res)) return;

    // `git merge --abort` mutates the worktree's index. Every other
    // in-worktree git mutation (the run worker's processTarget /
    // tryFinalizeAfterResolverFinished, the /complete + /merged finalize)
    // runs under this same per-task lock; an abort racing a live `git merge`
    // there means index.lock contention at best and a half-aborted merge
    // state at worst. The run's conflict WAIT parks lock-free, so the lock is
    // only ever held for the seconds a merge/finalize takes — wait that out
    // (a resolver Claude's give-up curl is one-shot and cannot retry), and
    // only then answer 409, which the Cancel button surfaces for the user to
    // click again.
    const lock = await acquireBriefly(task.id, deps.lockWaitMs ?? MERGE_ABORT_LOCK_WAIT_MS);
    if (!lock) {
      console.log(
        `[merge-aborted] task ${task.id}: merge lock held (a merge/finalize is in flight) — refusing`,
      );
      return res.status(409).json({
        error: 'a merge or finalize for this task is in progress — retry in a moment',
        finalizing: true,
      });
    }
    try {
      await deps.recover(task);
    } finally {
      release(lock);
    }

    // Release a parked merge-run worker so the run advances to the next task
    // (see the header note). No-op when no run is parked on this task.
    if (deps.signalConflictWaiter(task.id)) {
      console.log(
        `[merge-aborted] task ${task.id}: released parked merge-run worker`,
      );
    }

    res.json({ ok: true });
  };
}
