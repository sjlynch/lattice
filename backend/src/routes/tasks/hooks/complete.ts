// POST /api/tasks/:id/complete — the worktree's own Stop-hook callback.
//
// Two cases handled here, both driven by the worktree's own Stop hook:
//   in_progress -> ready_to_merge: the original task's Claude committed.
//   ready_to_merge + conflict:    the resolver Claude finished resolving
//                                 (delegated to finalizeResolvedTask).

import type { Request, Response } from 'express';
import { getTask, updateTask } from '../../../tasks.js';
import { branchCommitCount } from '../../../worktree.js';
import { proxyKillSessionsByCwd } from '../../../terminalProxy.js';
import { notifySessionsFreed } from '../../../spawnQueue.js';
import { finalizeResolvedTask } from '../finalizeResolved.js';
import { awaitPostMergeHookOutsideRun } from './postMergeHookHelper.js';

// Decide the in_progress → ready_to_merge transition from a commit-count
// probe. Reserve `awaiting-commit` (don't flip) for a *real, observed* zero —
// Claude finishing a turn without committing. A git error counting commits
// (transient `index.lock`, a momentary Windows file lock, a briefly-busy
// worktree dir) is NOT a genuine zero: the branch may well carry real
// commits, and the Stop hook fires exactly once, so reporting "no commits"
// here would strand a finished task at in_progress forever. Flip optimistically
// on error instead — a branch that turns out to be genuinely empty is still
// caught downstream by the merge's `emptyBranchOutcome`.
export async function decideInProgressComplete(
  countCommits: () => Promise<number>,
): Promise<'flip' | 'awaiting-commit'> {
  try {
    const commits = await countCommits();
    return commits === 0 ? 'awaiting-commit' : 'flip';
  } catch (err) {
    console.error('[complete] branchCommitCount failed; flipping anyway', err);
    return 'flip';
  }
}

// Hook callback: claude finished a turn.
//
// Source attribution: every callback site (Claude Stop hook curl, Pi
// extension fetch, model explicit curl) appends `?source=<tag>` so a
// failed/duplicate fire can be traced to its origin in the logs. Plain
// `?source=` is absent only for very-old workers that pre-date the
// hardened extension; their callbacks still work, they just log as
// "unknown".
export function handleTaskComplete(backendOrigin: string) {
  return async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    const source = typeof req.query.source === 'string' ? req.query.source : 'unknown';
    const task = await getTask(req.params.id);
    if (!task) {
      console.warn(
        `[complete] task ${req.params.id} not found (source=${source})`,
      );
      return res.status(404).json({ error: 'not found' });
    }
    console.log(
      `[complete] task ${task.id} (status=${task.status}, conflict=${!!task.conflict}, source=${source})`,
    );

    // Resolver-Claude finished. The merge in the worktree is committed;
    // fast-forward main and clean up.
    if (
      task.status === 'ready_to_merge' &&
      task.conflict &&
      task.branch &&
      task.worktreePath
    ) {
      const result = await finalizeResolvedTask(task, backendOrigin, 'complete');
      if (result.kind === 'mid-merge') {
        return res.json({ ok: true, awaitingResolution: true });
      }
      if (result.kind === 'already-finalizing') {
        // Another caller (the merge-run worker, or a duplicate hook fire)
        // holds the per-task merge lock and is finalizing this task. The
        // callback is idempotent, so report success and let the holder finish.
        return res.json({ ok: true, finalizing: true });
      }
      if (result.kind === 'merge-conflict') {
        return res.json({
          ok: true,
          requiresReResolution: true,
          conflictedFiles: result.conflictedFiles,
          command: result.command,
          cwd: result.cwd,
        });
      }
      if (result.kind === 'error') {
        return res.json({ ok: false, error: result.message });
      }
      await awaitPostMergeHookOutsideRun(task.projectPath, backendOrigin);
      return res.json({ ok: true, finalized: true });
    }

    if (task.status !== 'in_progress') {
      return res.json({ ok: true });
    }
    // Only flip when there are real commits — Claude finishing without
    // committing must NOT be reported as ready to merge. A *git error* while
    // counting is not the same as a real zero, though (see
    // decideInProgressComplete): flip optimistically rather than strand a
    // committed task at in_progress.
    if (task.branch && task.projectPath) {
      const branch = task.branch;
      const projectPath = task.projectPath;
      const decision = await decideInProgressComplete(() =>
        branchCommitCount(projectPath, branch),
      );
      if (decision === 'awaiting-commit') {
        console.warn(
          `[complete] task ${task.id} (${task.title}) hit Stop hook with ` +
            `no commits on ${task.branch} — leaving at in_progress.`,
        );
        return res.json({ ok: true, awaitingCommit: true });
      }
    }
    await updateTask(task.id, {
      status: 'ready_to_merge',
      completedAt: Date.now(),
    });
    res.json({ ok: true });

    // The in-worktree Claude has finished its turn and committed; the pty
    // now just holds an idle Claude waiting for input that will never come.
    // Kill it so terminal-server resources are released and the worktree's
    // dir lock is dropped on Windows. Deferred so the curl that called us
    // (running inside the very pty we're killing) gets to read this response
    // before the connection is torn down. The Stop hook's `curl -s -m 5`
    // exits in well under that, so 1s is plenty of slack.
    const wt = task.worktreePath;
    if (wt) {
      setTimeout(() => {
        proxyKillSessionsByCwd(wt)
          // The kill freed a pty slot — poke the spawn queue so a deferred
          // spawn reuses it now instead of waiting for the next poll.
          .then(() => notifySessionsFreed())
          .catch(() => {});
      }, 1000);
    }
  };
}
