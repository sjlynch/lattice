// Boot recovery: re-enqueue task runs that were waiting in the spawn queue
// when the backend stopped.
//
// The spawn queue is in-memory, so a restart loses its pending list. Task
// runs survive it because `/api/tasks/:id/run` persists `runQueued` (plus the
// requested harness/Pi model) on the task before enqueuing. This phase scans
// every known project for `status === 'open' && runQueued` tasks and
// re-enqueues each with its ORIGINAL harness/model.
//
// Idempotent against a crash mid-thunk: enqueueTaskRun → startTaskById →
// setupTaskWorktree, whose reconcileStaleState clears any half-created
// worktree from the interrupted attempt before re-creating it. Must run
// AFTER sweepOrphanedWorktrees (which would otherwise reclaim that worktree)
// — it does: this phase is invoked post-listen, the sweep runs pre-listen.

import { listTasks, updateTask, type Task } from '../tasks.js';
import { enqueueTaskRun } from '../routes/tasks/queuedSpawn.js';
import { isFreshlyRunnable } from '../routes/tasks/startTask.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

// Retry ceiling for boot re-enqueue. A run that fails deterministically (a
// corrupt/vanished worktree, a wedged terminal-server, or one that crashes the
// whole process mid-spawn) bumps `runFailureCount` at admission time; once it
// reaches this many attempts we stop re-enqueuing it on boot so it can't loop
// forever, and we clear its queued state so the card drops the "Queued" pill
// (it stays Open for a manual re-run, which starts from a clean counter).
// Without this a permanently-broken run is re-attempted every single boot.
const MAX_QUEUED_RUN_RETRIES = 3;

// Dependencies, injectable so the recovery decision (re-enqueue vs give up,
// harness/model round-trip) can be unit-tested without the real tasks store,
// spawn queue, or project index. Production wires the real implementations.
export type ResumeQueuedTaskRunsDeps = {
  forEachKnownProjectSafely: typeof forEachKnownProjectSafely;
  listTasks: typeof listTasks;
  enqueueTaskRun: typeof enqueueTaskRun;
  updateTask: typeof updateTask;
};

const defaultDeps: ResumeQueuedTaskRunsDeps = {
  forEachKnownProjectSafely,
  listTasks,
  enqueueTaskRun,
  updateTask,
};

export async function resumeQueuedTaskRuns(
  backendOrigin: string,
  deps: ResumeQueuedTaskRunsDeps = defaultDeps,
): Promise<void> {
  await deps.forEachKnownProjectSafely(
    'resumeQueuedTaskRuns',
    async (repoRoot) => {
      const tasks = await deps.listTasks(repoRoot);
      // Re-enqueue anything still flagged runQueued that is freshly runnable —
      // an Open task, or an In Progress task with no worktree (started fresh
      // from the In Progress lane). Leaving the latter unresumed would strand a
      // permanent "queued" pill on the card. Skip runs that have already failed
      // deterministically too many times so a broken run doesn't re-loop boot
      // after boot.
      const resumable = tasks.filter(
        (t) => t.runQueued && isFreshlyRunnable(t),
      );
      const queued = resumable.filter(
        (t) => (t.runFailureCount ?? 0) < MAX_QUEUED_RUN_RETRIES,
      );
      const givenUp = resumable.filter(
        (t) => (t.runFailureCount ?? 0) >= MAX_QUEUED_RUN_RETRIES,
      );
      for (const task of givenUp) {
        console.warn(
          `[startup] giving up on queued run for task ${task.id} ` +
            `("${task.title.slice(0, 40)}") — attempted ${task.runFailureCount} ` +
            `times, past the retry ceiling. Clearing queued state; re-run it ` +
            `manually to retry.`,
        );
        // Clear the queued state so the UI is not stuck with a permanent
        // "Queued" pill and a later manual re-run starts from a clean counter.
        await deps.updateTask(task.id, {
          runQueued: undefined,
          runQueuedAt: undefined,
          runQueuedHarness: undefined,
          runQueuedPiModel: undefined,
          runFailureCount: undefined,
        });
      }
      for (const task of queued) {
        console.log(
          `[startup] re-enqueuing interrupted queued run for task ${task.id} ` +
            `("${task.title.slice(0, 40)}")`,
        );
        // Re-enqueue with the originally-requested harness/Pi model, persisted
        // alongside runQueued. Absent ⇒ enqueueTaskRun falls back to the
        // project/global default (the same path a fresh run with no explicit
        // harness takes).
        await deps.enqueueTaskRun(
          task.id,
          backendOrigin,
          task.runQueuedHarness,
          task.runQueuedPiModel,
        );
      }
    },
  );
}
