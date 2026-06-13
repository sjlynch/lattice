// POST /api/tasks/:id/merge-aborted — resolver Claude gave up.
//
// Originally trusted the resolver to have already run `git merge --abort`
// and just cleared the conflict flag — but a resolver that curled this
// without aborting first (or that aborted in some other unexpected state)
// would leave MERGE_HEAD set with conflict:false, the orphan-mid-merge
// state that used to wedge the next /merge attempt. Now we abort ourselves
// if needed; preflight also auto-recovers, so this is belt + braces.

import type { Request, Response } from 'express';
import { getTask, updateTask } from '../../../tasks.js';
import { abortWorktreeMerge, isMidMerge } from '../../../worktree.js';

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
    res.json({ ok: true });
  };
}
