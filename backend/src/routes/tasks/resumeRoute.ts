import { Router } from 'express';
import path from 'node:path';
import { getTask } from '../../tasks.js';
import { worktreeExists } from '../../worktree.js';
import { requireTaskStatus } from './_shared.js';
import { selectHarnessCommand } from './harnessFactory.js';

export function buildTaskResumeRoute(): Router {
  const r = Router();

  // Resume an in_progress task — re-spawn Claude in the existing worktree
  // with a "continue what's been started" prompt. Useful when a previous
  // Claude session ended without committing (so /complete left the task at
  // in_progress) or when the dev server was restarted mid-task.
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
    const taskFile = path.join(task.worktreePath, 'LATTICE_TASK.md');
    const selectedHarness = selectHarnessCommand(task, {
      requestedHarness: req.body?.harness,
      mode: 'resume',
    });
    const { command, serverId } = await selectedHarness.createSession({
      taskFile,
      cwd: task.worktreePath,
    });
    res.json({
      worktreePath: task.worktreePath,
      branch: task.branch,
      taskFile,
      command,
      serverId,
    });
  });

  return r;
}
