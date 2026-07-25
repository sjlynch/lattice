// POST /api/tasks/:id/merge-aborted — resolver Claude gave up, OR the user
// clicked the Resolving-strip "Cancel" button to abandon a stuck resolution.
//
// Originally trusted the resolver to have already run `git merge --abort`
// and just cleared the conflict flag — but a resolver that curled this
// without aborting first (or that aborted in some other unexpected state)
// would leave MERGE_HEAD set with conflict:false, the orphan-mid-merge
// state that used to wedge the next /merge attempt. Now we abort ourselves
// if needed; preflight also auto-recovers, so this is belt + braces. The
// abort + conflict-clear + resolver-pty kill are shared with the merge-run
// liveness backstop via recoverAbandonedResolverTask.
//
// Clearing task.conflict here is what makes a cancel authoritative: a late
// /merged from a resolver that's still running (or never noticed it was
// abandoned) is gated on task.conflict and becomes a no-op. We ALSO kill the
// resolver pty so it stops working on the abandoned resolution entirely.
//
// AND we release any merge-run worker parked on this task's conflict waiter.
// During a backend merge run a conflicting task parks the worker on an untimed
// waiter (registerConflictWaiter). A give-up resolver aborts + curls THIS
// route; its later Stop-hook /complete is gated on the now-cleared task.conflict
// so it's a no-op and never signals. Without signalConflictWaiter here the run
// worker would await forever — never releasing the cross-process project
// run-lock and 409-ing every later /merge, merge-run, and workflow Merge step
// for the project until a backend restart. The aborted task is left at plain
// ready_to_merge to be retried on the next merge-all (so, unlike /complete and
// /merged, we deliberately do NOT restart a fresh run for it).

import type { Request, Response } from 'express';
import { getTask, type Task } from '../../../tasks.js';
import { signalConflictWaiter } from '../../../mergeRuns.js';
import { recoverAbandonedResolverTask } from '../../../mergeRuns/abandonedResolver.js';

// Injectable seam (production default below), mirroring finalizeResolved.ts: the
// regression test overrides these to register a real waiter on a throwaway run
// state and assert /merge-aborted releases it — without the merge-run singleton.
export type MergeAbortedDeps = {
  recover: (task: Task) => Promise<void>;
  signalConflictWaiter: (taskId: string) => boolean;
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

    await deps.recover(task);

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
