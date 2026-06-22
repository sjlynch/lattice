import { Router } from 'express';
import { getTask } from '../../tasks.js';
import { worktreeExists } from '../../worktree.js';
import { requireTaskStatus } from './_shared.js';
import { enqueueTaskResume } from './queuedSpawn.js';

export function buildTaskResumeRoute(): Router {
  const r = Router();

  // Resume an in_progress task — re-spawn Claude in the existing worktree
  // with a "continue what's been started" prompt. Useful when a previous
  // Claude session ended without committing (so /complete left the task at
  // in_progress) or when the dev server was restarted mid-task.
  //
  // The pre-checks here give fast 400 feedback; the spawn-queue thunk
  // re-validates before spawning (the worktree could vanish while queued).
  r.post('/api/tasks/:id/resume', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (!requireTaskStatus(task, 'in_progress', res)) return;
    if (!task.worktreePath) {
      return res
        .status(400)
        .json({ error: 'task has no worktree path on record' });
    }
    if (!(await worktreeExists(task.worktreePath))) {
      return res.status(400).json({
        error: `Worktree directory not found at ${task.worktreePath}. The worktree may have been removed manually.`,
      });
    }

    // Route through the spawn queue (see runRoute.ts). The terminal is
    // delivered via the `task-spawned` WS event when the pty spawns.
    const { queued } = await enqueueTaskResume(
      task.id,
      req.body?.harness,
      req.body?.piModel,
    );
    res.json({ accepted: true, queued });
  });

  return r;
}
