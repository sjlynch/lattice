// POST /api/tasks/:id/stash-resolved — Claude resolved a stash-pop conflict
// in the main repo. Finish cleanup and auto-restart the merge run for any
// remaining ready_to_merge tasks.

import type { Request, Response } from 'express';
import { getTask, updateTaskCrashSafe } from '../../../tasks.js';
import { cleanupWorktreeForTask } from '../../../worktree.js';
import { projectGit } from '../../../worktree/projectGit.js';
import { startMergeRunAfterMaintenance } from '../../../mergeRuns.js';
import { awaitPostMergeHookOutsideRun } from './postMergeHookHelper.js';
import { requireTaskInRequestedProject } from '../requestUtils.js';

// Injectable seam (production default below), mirroring mergeAborted.ts, so the
// status-guard regression test can prove cleanup is never reached.
export type StashResolvedDeps = {
  cleanupWorktree: typeof cleanupWorktreeForTask;
  // Restart for the remaining ready_to_merge tasks; waits out a housekeeping gc.
  startMergeRun?: (projectPath: string, backendOrigin: string) => Promise<{ total: number }>;
};

const productionDeps: StashResolvedDeps = {
  cleanupWorktree: cleanupWorktreeForTask,
};

// True only when `git merge-base --is-ancestor` positively says the branch is
// reachable from the project's HEAD. Any other outcome — not an ancestor (exit
// 1), a missing ref / git error (exit 128), or projectGit refusing because
// `.git` is gone — counts as "not merged": the caller then does nothing.
async function branchMergedIntoHead(projectPath: string, branch: string): Promise<boolean> {
  try {
    const r = await projectGit(projectPath, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD']);
    return r.code === 0;
  } catch {
    return false;
  }
}

export function handleTaskStashResolved(
  backendOrigin: string,
  deps: StashResolvedDeps = productionDeps,
) {
  return async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    // Removes the worktree and re-lanes the task: a `?project=` naming
    // another board is a 404 (the resolver's own curl sends none).
    if (!requireTaskInRequestedProject(task, req, res)) return;
    // The legitimate caller (worktree/finalize.ts) only ever spawns the stash
    // resolver for a ready_to_merge task. A stray or late curl against any other
    // lane must be an idempotent no-op (like /merged): before this guard it
    // ran cleanupWorktreeForTask — killing the ptys and removing the worktree
    // of an in_progress task — and flipped it to qa.
    if (task.status !== 'ready_to_merge') return res.json({ ok: true });
    // finalize.ts spawns the stash resolver only AFTER main was fast-forwarded
    // to the branch, so a legitimate call always finds the branch merged. A
    // ready_to_merge task whose branch is NOT in HEAD (a stray agent curl, or a
    // late one from an old stash-resolver tab after the task was reworked) must
    // be a no-op: before this check the cleanup below `branch -D`-ed its
    // unmerged commits and the qa flip stamped a mergedAt that the QA verdict
    // logic treats as a real merge.
    if (task.branch && !(await branchMergedIntoHead(task.projectPath, task.branch))) {
      console.warn(
        `[stash-resolved] ignoring for ${task.id}: branch ${task.branch} is not merged into HEAD`,
      );
      return res.json({ ok: true });
    }
    if (task.worktreePath && task.branch) {
      try {
        // Belt-and-braces: never force-delete a branch with unmerged commits,
        // even if HEAD moved between the ancestry check and here.
        await deps.cleanupWorktree(task.projectPath, task.worktreePath, task.branch, undefined, {
          keepBranchIfUnmerged: true,
        });
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
    //
    // A refusal because the post-run `git gc` is in flight is NOT "a run owns
    // the rest": nothing would retry after the gc, stranding the remaining
    // tasks (and the hook would fire alongside the repack). The restart waits
    // for the housekeeping and retries; only other refusals land in the catch.
    const startRun = deps.startMergeRun ?? startMergeRunAfterMaintenance;
    let startedRun: { total: number } | null = null;
    try {
      startedRun = await startRun(task.projectPath, backendOrigin);
    } catch {
      /* throws if a run is already active — that run owns the hook */
    }
    if (!startedRun || startedRun.total === 0) {
      await awaitPostMergeHookOutsideRun(task.projectPath, backendOrigin);
    }
    res.json({ ok: true });
  };
}
