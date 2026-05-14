import { startMergeRun, getActiveRunForProject } from '../mergeRuns.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { listTasks, type Task } from '../tasks.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

// A merge run executes inside the backend process. In dev, `tsc -w` +
// `node --watch` will restart that process whenever a merge fast-forwards
// `main` with a `backend/src/**` change (or the run's working-tree
// snapshot save/restore churns an uncommitted .ts file) — and the restart
// kills the in-flight run, leaving its `~/.lattice/per-project/<hash>/
// run.lock` behind with a now-dead PID. Pre-fix, the only way to continue
// was for the user to click "merge all" again (which steals the dead lock
// and starts over). This makes the backend do that itself: on boot, any
// project whose run.lock is a stale `merge-run` lock and still has
// `ready_to_merge` tasks gets a fresh run started automatically.
//
// `startMergeRun` re-scans `ready_to_merge` (including conflict-flagged
// tasks) and re-attempts each; partial states left by the interrupted run
// (worktree merged but `main` not yet FF'd, finalize half-done, etc.) are
// idempotent on a re-attempt, so resuming is just "run it again". Call
// this AFTER the HTTP server is listening — the run worker spawns resolver
// Claudes that curl back to the API.
export async function resumeInterruptedMergeRuns(backendOrigin: string): Promise<void> {
  await forEachKnownProjectSafely('resumeInterruptedMergeRuns', async (repoRoot) => {
    if (getActiveRunForProject(repoRoot)) return; // already running here

    const lock = await inspectProjectRunLock(repoRoot);
    if (!lock) return; // no run lock → nothing was interrupted
    if (lock.holder.label !== 'merge-run') return; // a manual /merge lock, not a run
    if (lock.alive) return; // owner still alive elsewhere — don't double-run

    const tasks = await listTasksOrEmpty(repoRoot);
    const pending = tasks.filter((t) => t.status === 'ready_to_merge');
    const startedIso = new Date(lock.holder.startedAt).toISOString();
    if (pending.length === 0) {
      console.log(
        `[startup] stale merge-run lock for ${repoRoot} (owner pid=${lock.holder.pid} died, ` +
          `started ${startedIso}) but no ready_to_merge tasks remain — nothing to resume.`,
      );
      return;
    }

    console.warn(
      `[startup] a merge run for ${repoRoot} was interrupted (owner pid=${lock.holder.pid} died, ` +
        `started ${startedIso}); ${pending.length} ready_to_merge task(s) remain — resuming automatically.`,
    );
    // Fire-and-forget; startMergeRun steals the dead lock itself.
    startMergeRun(repoRoot, backendOrigin).catch((err) => {
      console.error(`[startup] resume of merge run for ${repoRoot} failed to start:`, err);
    });
  });
}

async function listTasksOrEmpty(repoRoot: string): Promise<Task[]> {
  try {
    return await listTasks(repoRoot);
  } catch {
    return [];
  }
}
