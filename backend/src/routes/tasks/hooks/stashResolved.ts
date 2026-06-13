// POST /api/tasks/:id/stash-resolved — Claude resolved a stash-pop conflict
// in the main repo. Finish cleanup and auto-restart the merge run for any
// remaining ready_to_merge tasks.

import type { Request, Response } from 'express';
import { getTask, updateTaskCrashSafe } from '../../../tasks.js';
import { cleanupWorktreeForTask } from '../../../worktree.js';
import { startMergeRun } from '../../../mergeRuns.js';
import { awaitPostMergeHookOutsideRun } from './postMergeHookHelper.js';

export function handleTaskStashResolved(backendOrigin: string) {
  return async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.worktreePath && task.branch) {
      try {
        await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch);
      } catch {
        /* ignore — worktree may have already been removed */
      }
    }
    await updateTaskCrashSafe(task.id, {
      status: 'qa',
      mergedAt: Date.now(),
      worktreePath: undefined,
      branch: undefined,
      conflict: undefined,
      conflictStartedAt: undefined,
    });
    // Auto-restart merge run for any remaining ready_to_merge tasks. If a
    // new run picks tasks up it'll fire the post-merge hook at its end; if
    // not (no remaining work, or a run is already active), fire the hook
    // ourselves so the stash-resolved-driven qa transition blocks the merge
    // step like any other per-task merge does.
    let startedRun: { total: number } | null = null;
    try {
      startedRun = await startMergeRun(task.projectPath, backendOrigin);
    } catch {
      /* throws if a run is already active — that run owns the hook */
    }
    if (!startedRun || startedRun.total === 0) {
      await awaitPostMergeHookOutsideRun(task.projectPath, backendOrigin);
    }
    res.json({ ok: true });
  };
}
