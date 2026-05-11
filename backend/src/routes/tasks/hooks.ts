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
import { signalConflictWaiter, startMergeRun } from '../../mergeRuns.js';
import { mainIsAncestorOfWorktree } from '../../worktree.js';
import { proxyKillSessionsByCwd } from '../../terminalProxy.js';
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
      // Fix 1: if main is already an ancestor of the worktree branch, the
      // resolver committed against the current main and it hasn't moved since
      // (common case: the run was waiting sequentially, Fix 2). Skip the
      // re-merge — it would be a no-op at best and can spuriously conflict
      // if main moved due to a concurrent backend restart.
      const mainAlreadyMerged = await mainIsAncestorOfWorktree(
        task.projectPath,
        task.worktreePath,
      ).catch(() => false);

      let reSync: Awaited<ReturnType<typeof mergeWorktreeInRepo>>;
      if (mainAlreadyMerged) {
        console.log(`[complete] task ${task.id}: main already incorporated — skipping re-sync`);
        reSync = { status: 'clean' };
      } else {
        // Re-sync with current main before finalizing. The merge run may have
        // advanced main (via other tasks) while the resolver was working, making
        // the branch's merge commit stale relative to main — causing --ff-only
        // to fail. Merging again absorbs those new main commits; if that also
        // conflicts we need another resolver pass.
        reSync = await mergeWorktreeInRepo(
          task.projectPath,
          task.branch,
          task.worktreePath,
          task.id,
          backendOrigin,
          task.title,
        );
      }
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
        // Unblock any waiting merge run so it can move on to the next task;
        // this task stays conflicted and will be picked up on the next merge-all.
        if (!signalConflictWaiter(task.id)) {
          startMergeRun(task.projectPath, backendOrigin).catch(() => {});
        }
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
      // Signal the in-process merge run that spawned this resolver so it can
      // continue to the next task with the updated main HEAD. If no run is
      // waiting (e.g. the run was killed by a backend restart), start a fresh
      // one to pick up any remaining ready_to_merge tasks.
      if (!signalConflictWaiter(task.id)) {
        startMergeRun(task.projectPath, backendOrigin).catch(() => {});
      }
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
        proxyKillSessionsByCwd(wt).catch(() => {});
      }, 1000);
    }
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
    // Fix 1: skip the re-sync if main is already an ancestor of the branch
    // (same optimisation as /complete — see comment there).
    const mainAlreadyMergedForMerged = await mainIsAncestorOfWorktree(
      task.projectPath,
      task.worktreePath,
    ).catch(() => false);

    let reSyncForMerged: Awaited<ReturnType<typeof mergeWorktreeInRepo>>;
    if (mainAlreadyMergedForMerged) {
      console.log(`[merged] task ${task.id}: main already incorporated — skipping re-sync`);
      reSyncForMerged = { status: 'clean' };
    } else {
      // Re-sync with current main (same reason as /complete — see comment there).
      reSyncForMerged = await mergeWorktreeInRepo(
        task.projectPath,
        task.branch,
        task.worktreePath,
        task.id,
        backendOrigin,
        task.title,
      );
    }
    if (reSyncForMerged.status === 'conflict') {
      const { relativePath } = await writeMergeInstructions(
        task,
        task.branch,
        reSyncForMerged.conflictedFiles,
        backendOrigin,
        task.worktreePath,
      );
      await updateTask(task.id, { conflict: true, conflictStartedAt: Date.now() });
      if (!signalConflictWaiter(task.id)) {
        startMergeRun(task.projectPath, backendOrigin).catch(() => {});
      }
      return res.status(409).json({
        error: 'Re-sync with main introduced new conflicts — another resolver needed',
        command: buildConflictResolveCommand(relativePath),
        cwd: task.worktreePath,
        conflictedFiles: reSyncForMerged.conflictedFiles,
      });
    }
    if (reSyncForMerged.status === 'error') {
      return res.status(500).json({ error: `Re-sync with main failed: ${reSyncForMerged.message}` });
    }
    const fin = await finalizeMergedTask(task, backendOrigin);
    if (!fin.ok) {
      return res.status(500).json({ error: finalizeError(fin) });
    }
    if (!signalConflictWaiter(task.id)) {
      startMergeRun(task.projectPath, backendOrigin).catch(() => {});
    }
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
