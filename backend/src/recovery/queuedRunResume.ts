// Boot recovery: re-enqueue task runs that were waiting in the spawn queue
// when the backend stopped.
//
// The spawn queue is in-memory, so a restart loses its pending list. Task
// runs survive it because `/api/tasks/:id/run` persists `runQueued` on the
// task before enqueuing. This phase scans every known project for
// `status === 'open' && runQueued` tasks and re-enqueues each.
//
// Idempotent against a crash mid-thunk: enqueueTaskRun → startTaskById →
// setupTaskWorktree, whose reconcileStaleState clears any half-created
// worktree from the interrupted attempt before re-creating it. Must run
// AFTER sweepOrphanedWorktrees (which would otherwise reclaim that worktree)
// — it does: this phase is invoked post-listen, the sweep runs pre-listen.

import { listTasks } from '../tasks.js';
import { enqueueTaskRun } from '../routes/tasks/queuedSpawn.js';
import { isFreshlyRunnable } from '../routes/tasks/startTask.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

export async function resumeQueuedTaskRuns(
  backendOrigin: string,
): Promise<void> {
  await forEachKnownProjectSafely('resumeQueuedTaskRuns', async (repoRoot) => {
    const tasks = await listTasks(repoRoot);
    // Re-enqueue anything still flagged runQueued that is freshly runnable —
    // an Open task, or an In Progress task with no worktree (started fresh
    // from the In Progress lane). Leaving the latter unresumed would strand a
    // permanent "queued" pill on the card.
    const queued = tasks.filter((t) => t.runQueued && isFreshlyRunnable(t));
    for (const task of queued) {
      console.log(
        `[startup] re-enqueuing interrupted queued run for task ${task.id} ` +
          `("${task.title.slice(0, 40)}")`,
      );
      // The original requested harness is not persisted; fall back to the
      // project/global default (undefined ⇒ normalizeAgentHarness default).
      await enqueueTaskRun(task.id, backendOrigin, undefined);
    }
  });
}
