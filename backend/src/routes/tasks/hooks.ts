// Worktree lifecycle hook callbacks. Called by the in-worktree Claude's
// Stop hook (`/complete`, `/merged`, `/merge-aborted`, `/stash-resolved`).
// Logic here is dense — re-sync with main, finalize, conflict re-resolution.

import { Router } from 'express';
import {
  getTask,
  updateTask,
  updateTaskCrashSafe,
} from '../../tasks.js';
import {
  isMidMerge,
  mergeWorktreeInRepo,
  finalizeMergedTask,
  writeMergeInstructions,
  buildConflictResolveCommand,
  branchCommitCount,
  cleanupWorktreeForTask,
} from '../../worktree.js';
import { startMergeRun } from '../../mergeRuns.js';
import { finalizeError } from './_shared.js';

export function buildTaskHookRouter(backendOrigin: string): Router {
  const r = Router();

  // Hook callback: claude finished a turn.
  //
  // Two cases handled here, both driven by the worktree's own Stop hook:
  //   in_progress -> ready_to_merge: the original task's Claude committed.
  //   ready_to_merge + conflict:    the resolver Claude finished resolving.
  r.post('/api/tasks/:id/complete', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });

    // Resolver-Claude finished. The merge in the worktree is committed;
    // fast-forward main and clean up.
    if (
      task.status === 'ready_to_merge' &&
      task.conflict &&
      task.branch &&
      task.worktreePath
    ) {
      if (await isMidMerge(task.worktreePath)) {
        // Resolver hasn't committed yet (Stop fired mid-resolution).
        console.log(
          `[complete] task ${task.id}: resolver still mid-merge, skipping FF.`,
        );
        return res.json({ ok: true, awaitingResolution: true });
      }
      // Re-sync with current main before finalizing. The merge run may have
      // advanced main (via other tasks) while the resolver was working, making
      // the branch's merge commit stale relative to main — causing --ff-only
      // to fail. Merging again absorbs those new main commits; if that also
      // conflicts we need another resolver pass.
      const reSync = await mergeWorktreeInRepo(
        task.projectPath,
        task.branch,
        task.worktreePath,
        task.id,
        backendOrigin,
      );
      if (reSync.status === 'conflict') {
        const { relativePath } = await writeMergeInstructions(
          task,
          task.branch,
          reSync.conflictedFiles,
          backendOrigin,
          task.worktreePath,
        );
        await updateTask(task.id, { conflict: true, conflictStartedAt: Date.now() });
        console.log(
          `[complete] task ${task.id}: re-sync with main conflicted — resolver re-queued`,
        );
        return res.json({
          ok: true,
          requiresReResolution: true,
          conflictedFiles: reSync.conflictedFiles,
          command: buildConflictResolveCommand(relativePath),
          cwd: task.worktreePath,
        });
      }
      if (reSync.status === 'error') {
        console.warn(`[complete] task ${task.id}: re-sync with main failed: ${reSync.message}`);
        return res.json({ ok: false, error: reSync.message });
      }
      const fin = await finalizeMergedTask(task, backendOrigin);
      if (!fin.ok) {
        const msg = finalizeError(fin);
        console.warn(`[complete] finalize after resolution failed: ${msg}`);
        return res.json({ ok: false, error: msg });
      }
      // Auto-restart the run so any remaining ready_to_merge tasks are picked up.
      startMergeRun(task.projectPath, backendOrigin).catch(() => {});
      return res.json({ ok: true, finalized: true });
    }

    if (task.status !== 'in_progress') {
      return res.json({ ok: true });
    }
    // Only flip when there are real commits — Claude finishing without
    // committing must NOT be reported as ready to merge.
    if (task.branch && task.projectPath) {
      try {
        const commits = await branchCommitCount(task.projectPath, task.branch);
        if (commits === 0) {
          console.warn(
            `[complete] task ${task.id} (${task.title}) hit Stop hook with ` +
              `no commits on ${task.branch} — leaving at in_progress.`,
          );
          return res.json({ ok: true, awaitingCommit: true });
        }
      } catch (err) {
        console.error('[complete] branchCommitCount failed', err);
      }
    }
    await updateTask(task.id, {
      status: 'ready_to_merge',
      completedAt: Date.now(),
    });
    res.json({ ok: true });
  });

  // Resolver Claude reports it has finished the merge → ready_to_merge → qa.
  // Idempotent: duplicates after the task has already moved are a no-op.
  r.post('/api/tasks/:id/merged', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.status !== 'ready_to_merge') {
      return res.json({ ok: true });
    }
    if (!task.branch || !task.worktreePath) {
      return res.status(400).json({ error: 'task missing worktree info' });
    }
    if (await isMidMerge(task.worktreePath)) {
      return res
        .status(400)
        .json({ error: 'worktree is still mid-merge — commit first.' });
    }
    // Re-sync with current main (same reason as /complete — see comment there).
    const reSync = await mergeWorktreeInRepo(
      task.projectPath,
      task.branch,
      task.worktreePath,
      task.id,
      backendOrigin,
    );
    if (reSync.status === 'conflict') {
      const { relativePath } = await writeMergeInstructions(
        task,
        task.branch,
        reSync.conflictedFiles,
        backendOrigin,
        task.worktreePath,
      );
      await updateTask(task.id, { conflict: true, conflictStartedAt: Date.now() });
      return res.status(409).json({
        error: 'Re-sync with main introduced new conflicts — another resolver needed',
        command: buildConflictResolveCommand(relativePath),
        cwd: task.worktreePath,
        conflictedFiles: reSync.conflictedFiles,
      });
    }
    if (reSync.status === 'error') {
      return res.status(500).json({ error: `Re-sync with main failed: ${reSync.message}` });
    }
    const fin = await finalizeMergedTask(task, backendOrigin);
    if (!fin.ok) {
      return res.status(500).json({ error: finalizeError(fin) });
    }
    startMergeRun(task.projectPath, backendOrigin).catch(() => {});
    res.json({ ok: true });
  });

  // Resolver Claude gave up (after `git merge --abort`). Clear the in-flight
  // flag so the user can retry the merge.
  r.post('/api/tasks/:id/merge-aborted', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    await updateTask(task.id, {
      conflict: undefined,
      conflictStartedAt: undefined,
    });
    res.json({ ok: true });
  });

  // Claude resolved a stash-pop conflict in the main repo. Finish cleanup
  // and auto-restart the merge run for any remaining ready_to_merge tasks.
  r.post('/api/tasks/:id/stash-resolved', async (req, res) => {
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
    // Auto-restart merge run for any remaining ready_to_merge tasks.
    startMergeRun(task.projectPath, backendOrigin).catch(() => {
      /* throws if a run is already active or there are no remaining tasks — both fine */
    });
    res.json({ ok: true });
  });

  return r;
}
