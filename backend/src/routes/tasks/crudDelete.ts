// Delete + queued-run cancellation handlers. Both tear down spawn-queue
// state so a removed/cancelled task can't later spawn a worktree.

import type { Response } from 'express';
import { deleteTask, getTask } from '../../tasks.js';
import { cleanupWorktreeForTask } from '../../worktree.js';
import type { KeptBranchInfo } from '../../worktree/cleanup.js';
import { cancelQueuedTaskSpawns, dequeueTaskRun } from './queuedSpawn.js';
import { requireTaskInRequestedProject } from './requestUtils.js';
import type { TaskIdRequest } from './crudTypes.js';

// Cancel a queued task run: drop it from the spawn queue and clear the
// runQueued flag so it reverts to a plain Open task. Idempotent — a no-op
// for a task that is not queued. A run the queue had already admitted is
// aborted rather than dropped (it backs out before starting its agent); the
// response then carries `inFlight: true`.
export async function handleTaskCancelQueuedRun(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!requireTaskInRequestedProject(task, req, res)) return;
  const { inFlight } = await dequeueTaskRun(req.params.id);
  const updated = await getTask(req.params.id);
  const inFlightField = inFlight ? { inFlight: true } : {};
  res.json(updated ? { ...updated, ...inFlightField } : { ok: true, ...inFlightField });
}

export async function handleTaskDelete(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const task = await getTask(req.params.id);
  // A delete is the one call where reaching the wrong board is unrecoverable,
  // so the project pin is checked before ANY side effect (the queue cancel
  // below included).
  if (task && !requireTaskInRequestedProject(task, req, res)) return;
  // Drop any queued run/resume (aborting one already in flight) so the spawn
  // queue does not spawn a worktree for a task that no longer exists.
  cancelQueuedTaskSpawns(req.params.id);
  // A holder object, not a `let`: TS would narrow a closure-assigned `let` to null.
  const keptRef: { info: KeptBranchInfo | null } = { info: null };
  if (task && task.worktreePath && task.branch) {
    try {
      // The worktree goes (uncommitted edits archived as usual), but a branch
      // with commits not in HEAD is the only copy of that work — keep it.
      await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch, undefined, {
        keepBranchIfUnmerged: true,
        onBranchKept: (info) => { keptRef.info = info; },
      });
    } catch {
      /* ignore — worktree may have already been removed manually */
    }
  }
  const ok = await deleteTask(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const kept = keptRef.info;
  res.json(kept ? { ok: true, keptBranch: keptBranchPayload(kept) } : { ok: true });
}

export function keptBranchPayload(info: KeptBranchInfo): KeptBranchInfo & { hint: string } {
  const what = info.unmergedCommits === null
    ? 'its unmerged-commit count could not be determined'
    : `${info.unmergedCommits} unmerged commit(s)`;
  return {
    ...info,
    hint: `kept branch ${info.name}: ${what}. Merge it, or run ` +
      `\`git branch -D ${info.name}\` to discard.`,
  };
}
