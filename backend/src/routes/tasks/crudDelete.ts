// Delete + queued-run cancellation handlers. Both tear down spawn-queue
// state so a removed/cancelled task can't later spawn a worktree.

import type { Response } from 'express';
import { deleteTask, getTask } from '../../tasks.js';
import { cleanupWorktreeForTask } from '../../worktree.js';
import { cancelQueuedTaskSpawns, dequeueTaskRun } from './queuedSpawn.js';
import type { TaskIdRequest } from './crudTypes.js';

// Cancel a queued task run: drop it from the spawn queue and clear the
// runQueued flag so it reverts to a plain Open task. Idempotent — a no-op
// for a task that is not queued.
export async function handleTaskCancelQueuedRun(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await dequeueTaskRun(req.params.id);
  const updated = await getTask(req.params.id);
  res.json(updated ?? { ok: true });
}

export async function handleTaskDelete(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const task = await getTask(req.params.id);
  // Drop any still-pending queued run/resume so the spawn queue does not
  // later try to spawn a worktree for a task that no longer exists.
  cancelQueuedTaskSpawns(req.params.id);
  if (task && task.worktreePath && task.branch) {
    try {
      await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch);
    } catch {
      /* ignore — worktree may have already been removed manually */
    }
  }
  const ok = await deleteTask(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
}
