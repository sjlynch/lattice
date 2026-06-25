// POST /api/tasks/:id/merged — resolver Claude reports it has finished the
// merge → ready_to_merge → qa. Idempotent: duplicates after the task has
// already moved are a no-op.

import type { Request, Response } from 'express';
import { getTask } from '../../../tasks.js';
import { finalizeResolvedTask } from '../finalizeResolved.js';
import { awaitPostMergeHookOutsideRun } from './postMergeHookHelper.js';

export function handleTaskMerged(backendOrigin: string) {
  return async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    // Resolver finalization is authoritative ONLY while the task is still
    // flagged conflicted. The Resolving-strip Cancel button (/merge-aborted)
    // clears task.conflict to abandon a stuck resolution; a late /merged from
    // that now-orphaned resolver — it kept running and curled this after the
    // user cancelled — must be a harmless no-op, NOT silently advance the task
    // to qa and fast-forward main behind the user's back. (/complete's
    // resolver branch already gates on task.conflict; this brings /merged in
    // line so the cancel is genuinely authoritative.)
    if (task.status !== 'ready_to_merge' || !task.conflict) {
      return res.json({ ok: true });
    }
    if (!task.branch || !task.worktreePath) {
      return res.status(400).json({ error: 'task missing worktree info' });
    }
    const result = await finalizeResolvedTask(task, backendOrigin, 'merged');
    if (result.kind === 'mid-merge') {
      return res
        .status(400)
        .json({ error: 'worktree is still mid-merge — commit first.' });
    }
    if (result.kind === 'already-finalizing') {
      // Another caller (the merge-run worker, or a duplicate hook fire) holds
      // the per-task merge lock and is finalizing this task. The callback is
      // idempotent, so report success and let the holder finish.
      return res.json({ ok: true, finalizing: true });
    }
    if (result.kind === 'merge-conflict') {
      return res.status(409).json({
        error: 'Re-sync with main introduced new conflicts — another resolver needed',
        command: result.command,
        cwd: result.cwd,
        conflictedFiles: result.conflictedFiles,
      });
    }
    if (result.kind === 'error') {
      const error =
        result.phase === 'merge'
          ? `Re-sync with main failed: ${result.message}`
          : result.message;
      return res.status(500).json({ error });
    }
    await awaitPostMergeHookOutsideRun(task.projectPath, backendOrigin);
    res.json({ ok: true });
  };
}
