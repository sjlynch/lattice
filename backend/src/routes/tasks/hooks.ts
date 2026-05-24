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
  abortWorktreeMerge,
  branchCommitCount,
  cleanupWorktreeForTask,
  isMidMerge,
} from '../../worktree.js';
import { getActiveRunForProject, startMergeRun } from '../../mergeRuns.js';
import { runPostMergeHookGate } from '../../postMergeHooks.js';
import { proxyKillSessionsByCwd } from '../../terminalProxy.js';
import { notifySessionsFreed } from '../../spawnQueue.js';
import { finalizeResolvedTask } from './finalizeResolved.js';

// Resolver-finished tasks transition to qa, which counts as a "merge" for
// the purposes of the post-merge hook. Skip when a merge run is active: the
// run owns its own end-of-run hook fire, and double-firing would deadlock
// the run on its own gate (the per-task await holds the gate, the run can't
// reach finishRun until it returns).
async function awaitPostMergeHookOutsideRun(
  projectPath: string,
  backendOrigin: string,
): Promise<void> {
  if (getActiveRunForProject(projectPath)) return;
  try {
    await runPostMergeHookGate({
      projectPath,
      backendOrigin,
      trigger: 'manual-merge',
    });
  } catch (err) {
    console.warn(
      '[task-hook] post-merge hook gate threw (continuing):',
      err,
    );
  }
}

export function buildTaskHookRouter(backendOrigin: string): Router {
  const r = Router();

  // Hook callback: claude finished a turn.
  //
  // Two cases handled here, both driven by the worktree's own Stop hook:
  //   in_progress -> ready_to_merge: the original task's Claude committed.
  //   ready_to_merge + conflict:    the resolver Claude finished resolving
  //                                 (delegated to finalizeResolvedTask).
  //
  // Source attribution: every callback site (Claude Stop hook curl, Pi
  // extension fetch, model explicit curl) appends `?source=<tag>` so a
  // failed/duplicate fire can be traced to its origin in the logs. Plain
  // `?source=` is absent only for very-old workers that pre-date the
  // hardened extension; their callbacks still work, they just log as
  // "unknown".
  r.post('/api/tasks/:id/complete', async (req, res) => {
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
        proxyKillSessionsByCwd(wt)
          // The kill freed a pty slot — poke the spawn queue so a deferred
          // spawn reuses it now instead of waiting for the next poll.
          .then(() => notifySessionsFreed())
          .catch(() => {});
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
    await awaitPostMergeHookOutsideRun(task.projectPath, backendOrigin);
    res.json({ ok: true });
  });

  // Resolver Claude gave up. Originally trusted the resolver to have
  // already run `git merge --abort` and just cleared the conflict flag —
  // but a resolver that curled this without aborting first (or that
  // aborted in some other unexpected state) would leave MERGE_HEAD set
  // with conflict:false, the orphan-mid-merge state that used to wedge
  // the next /merge attempt. Now we abort ourselves if needed; preflight
  // also auto-recovers, so this is belt + braces.
  r.post('/api/tasks/:id/merge-aborted', async (req, res) => {
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
  });

  return r;
}
