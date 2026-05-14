import { Router } from 'express';
import { getTask, updateTask } from '../../tasks.js';
import { setupTaskWorktree } from '../../worktree.js';
import { logTaskRouteError, requireTaskStatus } from './_shared.js';
import { selectHarnessCommand } from './harnessFactory.js';

export function buildTaskRunRoute(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/tasks/:id/run', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (!requireTaskStatus(task, 'open', res)) return;
    try {
      const selectedHarness = selectHarnessCommand(task, {
        requestedHarness: req.body?.harness,
        mode: 'run',
      });
      const result = await setupTaskWorktree(
        task.projectPath,
        task,
        backendOrigin,
        selectedHarness.harness,
      );
      await updateTask(task.id, {
        status: 'in_progress',
        worktreePath: result.worktreePath,
        branch: result.branch,
        startedAt: Date.now(),
      });
      // Pre-spawn the pty so the frontend can lazy-mount its terminal pane
      // (and avoid burning a WebGL context per task at "Run All" time).
      const { command, serverId } = await selectedHarness.createSession({
        taskFile: result.taskFile,
        cwd: result.worktreePath,
      });
      res.json({
        worktreePath: result.worktreePath,
        branch: result.branch,
        taskFile: result.taskFile,
        command,
        serverId,
      });
    } catch (err) {
      logTaskRouteError(task, 'run setupTaskWorktree failed', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}
