import { getTask, listTasks } from '../tasks.js';
import { resumeTaskReview } from '../taskReview.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { reviewScratchKey, reviewScratchPaths } from '../taskReview/runner.js';
import { cleanupHomeScratchSession } from '../homeScratch/cleanup.js';
import { sweepOrphanedHomeScratchSessions, type HomeScratchSweepDeps } from '../homeScratch/sweep.js';
import { runExclusive } from '../serializeWrites.js';

// CLI reviews died with the previous backend. Queue them once; the shared
// per-task flight dedupes boot recovery against outbox completion replays.
// Also finish a rerun whose durable intent preceded interrupted teardown.
export async function resumeInterruptedTaskReviews(backendOrigin: string, deps = {
  forEachProject: forEachKnownProjectSafely, listTasks, resume: resumeTaskReview,
}): Promise<void> {
  await deps.forEachProject('resumeInterruptedTaskReviews', async (project) => {
    for (const task of await deps.listTasks(project)) {
      if (task.status === 'in_progress' &&
          (task.review?.status === 'reviewing' || (task.review?.status === 'rerun' && task.review.rerunPending))) {
        deps.resume(task, backendOrigin);
      }
    }
  });
}

// Headless jobs have no PTY in the executor inventory. Preserve active task
// reviews explicitly; serialize cleanup with the runner to avoid an admission
// racing this sweep between its task read and guarded recursive removal.
export async function sweepTaskReviewScratch(deps?: HomeScratchSweepDeps & { cleanup?: typeof cleanupHomeScratchSession }): Promise<void> {
  await sweepOrphanedHomeScratchSessions({
    label: 'taskReviewScratch', noun: 'task review', paths: reviewScratchPaths, deps,
    cleanup: (projectPath, id) => runExclusive(reviewScratchKey(projectPath, id), async () => {
      const task = await getTask(id);
      if (task?.status === 'in_progress' &&
          (task.review?.status === 'reviewing' || task.review?.rerunPending)) return;
      await (deps?.cleanup ?? cleanupHomeScratchSession)({ paths: reviewScratchPaths, projectPath, id, logLabel: '[task-review]' });
    }),
  });
}
