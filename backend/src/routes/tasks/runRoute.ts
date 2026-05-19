import { Router } from 'express';
import { getTask } from '../../tasks.js';
import { logTaskRouteError, requireTaskStatus } from './_shared.js';
import { startTaskById } from './startTask.js';

export function buildTaskRunRoute(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/tasks/:id/run', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (!requireTaskStatus(task, 'open', res)) return;
    try {
      // Pre-spawn the pty so the frontend can lazy-mount its terminal pane
      // (and avoid burning a WebGL context per task at "Run All" time).
      const result = await startTaskById(task.id, backendOrigin, {
        requestedHarness: req.body?.harness,
      });
      res.json({
        worktreePath: result.worktreePath,
        branch: result.branch,
        taskFile: result.taskFile,
        command: result.command,
        serverId: result.serverId,
      });
    } catch (err) {
      logTaskRouteError(task, 'run setupTaskWorktree failed', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}
