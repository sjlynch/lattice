// Worktree lifecycle hook callbacks. Called by the in-worktree Claude's
// Stop hook (`/complete`, `/merged`, `/merge-aborted`, `/stash-resolved`).
//
// The resolver-finished branch of `/complete` and the entirety of `/merged`
// share the same "re-sync with main, finalize, requeue on conflict" flow —
// extracted into `finalizeResolvedTask` (./finalizeResolved.ts). Each route
// only renders the discriminated result into its own HTTP shape.

import { Router } from 'express';
import {
  getTask,
  updateTask,
  updateTaskCrashSafe,
} from '../../tasks.js';
import {
  branchCommitCount,
  cleanupWorktreeForTask,
} from '../../worktree.js';
import { startMergeRun } from '../../mergeRuns.js';
import { proxyKillSessionsByCwd } from '../../terminalProxy.js';
import { finalizeResolvedTask } from './finalizeResolved.js';

export function buildTaskHookRouter(backendOrigin: string): Router {
  const r = Router();

  // Hook callback: claude finished a turn.
  //
  // Two cases handled here, both driven by the worktree's own Stop hook:
  //   in_progress -> ready_to_merge: the original task's Claude committed.
  //   ready_to_merge + conflict:    the resolver Claude finished resolving
  //                                 (delegated to finalizeResolvedTask).
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
      const result = await finalizeResolvedTask(task, backendOrigin, 'complete');
      if (result.kind === 'mid-merge') {
        return res.json({ ok: true, awaitingResolution: true });
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
    const result = await finalizeResolvedTask(task, backendOrigin, 'merged');
    if (result.kind === 'mid-merge') {
      return res
        .status(400)
        .json({ error: 'worktree is still mid-merge — commit first.' });
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
