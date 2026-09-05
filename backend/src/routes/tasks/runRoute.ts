import { Router } from 'express';
import { getTask } from '../../tasks.js';
import { isFreshlyRunnable } from './startTask.js';
import { enqueueTaskRun } from './queuedSpawn.js';
import { requireTaskInRequestedProject } from './requestUtils.js';

export function buildTaskRunRoute(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/tasks/:id/run', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    // Spawning an agent on another project's task is the worst-case wrong-board
    // outcome, so honour the caller's `?project=` pin when it sends one.
    if (!requireTaskInRequestedProject(task, req, res)) return;
    // Runnable from scratch when the task is Open, or In Progress with no
    // worktree yet (dragged into the lane manually, never actually started).
    // Either way startTaskById sets up a fresh worktree and spawns the agent.
    if (!isFreshlyRunnable(task)) {
      return res.status(400).json({
        error: `task is "${task.status}" with a worktree; only an open task (or an in-progress task with no worktree) can be run`,
      });
    }

    // Route the run through the spawn queue. If concurrency headroom exists
    // the worktree setup + pty spawn happen immediately; otherwise the run
    // is deferred in a durable queue (never dropped). Either way the pty —
    // when it spawns — is delivered to the frontend via the `task-spawned`
    // WS event, not this HTTP response.
    const { queued } = await enqueueTaskRun(
      task.id,
      backendOrigin,
      req.body?.harness,
      req.body?.piModel,
    );
    res.json({ accepted: true, queued });
  });

  return r;
}
