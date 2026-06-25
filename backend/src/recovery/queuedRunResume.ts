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

// Retry ceiling for boot re-enqueue. A run that fails deterministically (a
// corrupt/vanished worktree, a wedged terminal-server) bumps `runFailureCount`
// each time its thunk fails; past this many failures we stop re-enqueuing it on
// boot so it can't loop forever (it stays Open for a manual re-run, which
// resets the counter). Without this a permanently-broken run is re-attempted
// every single boot.
const MAX_QUEUED_RUN_RETRIES = 3;

export async function resumeQueuedTaskRuns(
  backendOrigin: string,
): Promise<void> {
  await forEachKnownProjectSafely('resumeQueuedTaskRuns', async (repoRoot) => {
    const tasks = await listTasks(repoRoot);
    // Re-enqueue anything still flagged runQueued that is freshly runnable —
    // an Open task, or an In Progress task with no worktree (started fresh
    // from the In Progress lane). Leaving the latter unresumed would strand a
    // permanent "queued" pill on the card. Skip runs that have already failed
    // deterministically too many times so a broken run doesn't re-loop boot
    // after boot.
    const queued = tasks.filter(
      (t) =>
        t.runQueued &&
        isFreshlyRunnable(t) &&
        (t.runFailureCount ?? 0) < MAX_QUEUED_RUN_RETRIES,
    );
    const givenUp = tasks.filter(
      (t) =>
        t.runQueued &&
        isFreshlyRunnable(t) &&
        (t.runFailureCount ?? 0) >= MAX_QUEUED_RUN_RETRIES,
    );
    for (const task of givenUp) {
      console.warn(
        `[startup] NOT re-enqueuing queued run for task ${task.id} ` +
          `("${task.title.slice(0, 40)}") — failed ${task.runFailureCount} ` +
          `times, past the retry ceiling. Re-run it manually to retry.`,
      );
    }
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
