import { Router } from 'express';
import { getTask } from '../../tasks.js';
import { getActiveRunForProject } from '../../mergeRuns.js';
import { requireTaskStatus } from './_shared.js';
import { isProjectManualMergeActive } from './manualMergeGuards.js';
import { withManualMergeLock } from './manualMergeLocks.js';
import { runManualMerge } from './manualMergeService.js';
import type { MergeReadyTask } from './manualMergeTypes.js';

export function buildTaskMergeRoute(backendOrigin: string): Router {
  const r = Router();

  // Initiate the merge for a ready_to_merge task.
  //   clean    -> cleanup worktree, flip task to qa
  //   conflict -> task stays at ready_to_merge with conflict=true; backend
  //               returns the resolver Claude prompt for the UI to spawn.
  r.post('/api/tasks/:id/merge', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (!requireTaskStatus(task, 'ready_to_merge', res)) return;
    if (!task.branch || !task.worktreePath) {
      return res
        .status(400)
        .json({ error: 'task has no worktree branch on record' });
    }
    const mergeTask = task as MergeReadyTask;

    if (getActiveRunForProject(task.projectPath)) {
      return res.status(409).json({
        error: 'A merge run is in progress for this project — wait for it to finish.',
      });
    }
    if (isProjectManualMergeActive(task.projectPath)) {
      return res.status(409).json({
        error: 'Another merge is already in progress for this project — wait a moment and retry.',
      });
    }

    const lockResult = await withManualMergeLock(task.id, () =>
      runManualMerge(mergeTask, backendOrigin, res),
    );

    if (!lockResult.acquired) {
      return res
        .status(409)
        .json({ error: 'merge already in progress for this task' });
    }
    return lockResult.value;
  });

  return r;
}
