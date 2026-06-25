// POST /api/tasks/:id/merge-aborted — resolver Claude gave up, OR the user
// clicked the Resolving-strip "Cancel" button to abandon a stuck resolution.
//
// Originally trusted the resolver to have already run `git merge --abort`
// and just cleared the conflict flag — but a resolver that curled this
// without aborting first (or that aborted in some other unexpected state)
// would leave MERGE_HEAD set with conflict:false, the orphan-mid-merge
// state that used to wedge the next /merge attempt. Now we abort ourselves
// if needed; preflight also auto-recovers, so this is belt + braces.
//
// Clearing task.conflict here is what makes a cancel authoritative: a late
// /merged from a resolver that's still running (or never noticed it was
// abandoned) is gated on task.conflict and becomes a no-op. We ALSO kill the
// resolver pty so it stops working on the abandoned resolution entirely.

import type { Request, Response } from 'express';
import { getTask, updateTask } from '../../../tasks.js';
import { abortWorktreeMerge, isMidMerge } from '../../../worktree.js';
import { proxyKillSessionsByCwd } from '../../../terminalProxy.js';
import { notifySessionsFreed } from '../../../spawnQueue.js';

export function handleTaskMergeAborted(_backendOrigin: string) {
  return async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.worktreePath) {
      try {
        if (await isMidMerge(task.worktreePath)) {
          const aborted = await abortWorktreeMerge(task.worktreePath);
          if (!aborted.ok) {
            console.warn(
              `[merge-aborted] task ${task.id}: git merge --abort failed: ${aborted.message}`,
            );
          }
        }
      } catch (err) {
        console.warn(
          `[merge-aborted] task ${task.id}: abort check threw (continuing):`,
          err,
        );
      }
    }
    await updateTask(task.id, {
      conflict: undefined,
      conflictStartedAt: undefined,
    });

    // Kill the orphaned resolver pty (if any) running in this worktree so it
    // can't keep churning — or curl /merged — against an abandoned
    // resolution. The worktree cwd is unique to this task and its original
    // worktree agent was already killed at the ready_to_merge transition, so
    // the only session here is the resolver. The /merged conflict guard above
    // is the authoritative safety net; this is the resource-cleanup half.
    if (task.worktreePath) {
      const wt = task.worktreePath;
      proxyKillSessionsByCwd(wt)
        // The kill freed a pty slot — poke the spawn queue so a deferred spawn
        // reuses it now instead of waiting for the next poll.
        .then(() => notifySessionsFreed())
        .catch(() => {});
    }
    res.json({ ok: true });
  };
}
