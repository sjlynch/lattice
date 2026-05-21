import { Router } from 'express';
import { getTask } from '../../tasks.js';
import { requireTaskStatus } from './_shared.js';
import { enqueueTaskRun } from './queuedSpawn.js';

export function buildTaskRunRoute(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/tasks/:id/run', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (!requireTaskStatus(task, 'open', res)) return;

    // Route the run through the spawn queue. If concurrency headroom exists
    // the worktree setup + pty spawn happen immediately; otherwise the run
    // is deferred in a durable queue (never dropped). Either way the pty —
    // when it spawns — is delivered to the frontend via the `task-spawned`
    // WS event, not this HTTP response.
    const { queued } = await enqueueTaskRun(
      task.id,
      backendOrigin,
      req.body?.harness,
    );
    res.json({ accepted: true, queued });
  });

  return r;
}
