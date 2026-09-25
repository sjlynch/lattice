import { startMergeRun, getActiveRunForProject } from '../mergeRuns.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { projectRunLockFilePath } from '../projectRunLock/paths.js';
import { clearStaleLockOrThrow } from '../projectRunLock/steal.js';
import {
  clearInterruptedRun,
  isResumableInterruptedRunLock,
  readInterruptedRun,
} from '../projectRunLock/interruptedRun.js';
import { listTasks, type Task } from '../tasks.js';
import { getActiveRunsForProject as getActiveWorkflowRunsForProject } from '../workflowRuns.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { readRecoveryAttempts } from './retryBudget.js';

// Which stale run-lock labels mean an interrupted merge worth resuming — see
// projectRunLock/interruptedRun.ts (moved there so boot snapshot recovery can
// use it without importing the merge-run engine). Re-exported for callers.
export { isResumableInterruptedRunLock };

// A merge run executes inside the backend process. In dev, `tsc -w` +
// `node --watch` will restart that process whenever a merge fast-forwards
// `main` with a `backend/src/**` change (or the run's working-tree
// snapshot save/restore churns an uncommitted .ts file) — and the restart
// kills the in-flight run, leaving its `~/.lattice/per-project/<hash>/
// run.lock` behind with a now-dead PID. Pre-fix, the only way to continue
// was for the user to click "merge all" again (which steals the dead lock
// and starts over). This makes the backend do that itself: on boot, any
// project whose run.lock is a stale run/workflow-merge lock (see
// `isResumableInterruptedRunLock`) and still has `ready_to_merge` tasks gets
// a fresh run started automatically. Boot snapshot recovery, which runs
// first, may already have stolen and retired that dead lock to restore a
// pending snapshot; it leaves an interrupted-run marker instead
// (projectRunLock/interruptedRun.ts), which stands in for the lock here.
//
// `startMergeRun` re-scans `ready_to_merge` (including conflict-flagged
// tasks) and re-attempts each; partial states left by the interrupted run
// (worktree merged but `main` not yet FF'd, finalize half-done, etc.) are
// idempotent on a re-attempt, so resuming is just "run it again". Call
// this AFTER the HTTP server is listening — the run worker spawns resolver
// Claudes that curl back to the API.
export async function resumeInterruptedMergeRuns(
  backendOrigin: string,
  deps: { startMergeRun: typeof startMergeRun } = { startMergeRun },
): Promise<void> {
  await forEachKnownProjectSafely('resumeInterruptedMergeRuns', async (repoRoot) => {
    // In both early returns something already drains Ready-to-Merge, so an
    // interrupted-run marker has nothing left to do (and would otherwise
    // outlive this boot and auto-start a merge on a later one).
    if (getActiveRunForProject(repoRoot)) {
      await clearInterruptedRunQuietly(repoRoot);
      return; // already running here
    }
    // A workflow run resumed moments ago (resumeInterruptedWorkflowRuns runs
    // first) owns this project's merge pipeline: its own Merge control step
    // drains Ready-to-Merge under the same run lock. Starting a second,
    // independent merge run here would race it for the lock and double-process
    // the same tasks. Pre-persistence there were never active workflow runs at
    // boot, so this guard is inert for every other path.
    if (getActiveWorkflowRunsForProject(repoRoot).length > 0) {
      console.log(
        `[startup] skipping merge-run resume for ${repoRoot} — a resumed workflow run owns its merge pipeline.`,
      );
      await clearInterruptedRunQuietly(repoRoot);
      return;
    }

    const lock = await inspectProjectRunLock(repoRoot);
    // No lock: nothing was interrupted, unless snapshot recovery retired it.
    const holder = lock?.holder ?? (await readInterruptedRun(repoRoot));
    if (!holder) return;
    // Only a merge-run or a workflow Merge/Push control-step lock: a manual
    // /merge lock (or a workflow Start lock) is not resumed here.
    if (!isResumableInterruptedRunLock(holder.label)) return;
    if (lock?.alive) return; // owner still alive elsewhere — don't double-run
    if (holder.label.startsWith('workflow-')) {
      const workflowId = holder.label.slice(holder.label.indexOf(':') + 1);
      const paused = (await readRecoveryAttempts(repoRoot)).find((r) => r.operation === `workflow:${workflowId}` && r.paused);
      if (paused) {
        console.error(`[startup] ${repoRoot}: ${paused.paused}`);
        return;
      }
    }

    const tasks = await listTasksOrEmpty(repoRoot);
    const pending = tasks.filter((t) => t.status === 'ready_to_merge');
    const startedIso = new Date(holder.startedAt).toISOString();
    if (pending.length === 0) {
      console.log(
        `[startup] stale run lock "${holder.label}" for ${repoRoot} (owner pid=${holder.pid} died, ` +
          `started ${startedIso}) but no ready_to_merge tasks remain — nothing to resume; retiring the lock.`,
      );
      await clearInterruptedRunQuietly(repoRoot);
      if (!lock) return;
      // Nothing will ever acquire (and so steal) this lock on its own, so
      // without this it outlives every boot that noticed it — and a dead lock
      // whose PID the OS later recycles is what the dev runner's restart
      // deferral misread as a live operation (2026-09-22). `clearStaleLockOrThrow`
      // re-checks liveness (PID + process start time) before retiring, so a
      // holder that came alive meanwhile is refused, not stolen.
      try {
        await clearStaleLockOrThrow(projectRunLockFilePath(repoRoot));
      } catch (err) {
        console.warn(`[startup] could not retire the stale run lock for ${repoRoot}:`, err);
      }
      return;
    }

    console.warn(
      `[startup] an interrupted run ("${holder.label}") for ${repoRoot} left work behind (owner pid=${holder.pid} died, ` +
        `started ${startedIso}); ${pending.length} ready_to_merge task(s) remain — resuming a merge automatically.`,
    );
    // Awaited — but only up to registration: `startMergeRun` steals the dead
    // lock itself, registers the run in `runState.runs`, and resolves; the
    // worker body is fire-and-forget inside it. Awaiting matters because the
    // boot step after this one, `fireOwedPostMergeHooks`, skips a project with
    // an active merge run (that run's teardown fires the owed hook). Left
    // un-awaited, its `getActiveRunForProject` check ran before the several
    // awaits that precede registration had finished, so the owed hook started
    // on the main checkout beside the resumed run — the run's preflight
    // snapshot/reset raced the hook's edits, and its teardown fired a second
    // hook for the same merges.
    try {
      await deps.startMergeRun(repoRoot, backendOrigin, { automaticRecovery: true });
      // The run is registered (and holds its own lock) — the marker has done
      // its job. Kept on a failed start, like a stale lock, so the next boot
      // retries and the owed hook stays deferred meanwhile.
      await clearInterruptedRunQuietly(repoRoot);
    } catch (err) {
      console.error(`[startup] resume of merge run for ${repoRoot} failed to start:`, err);
    }
  });
}

async function clearInterruptedRunQuietly(repoRoot: string): Promise<void> {
  await clearInterruptedRun(repoRoot).catch((err) =>
    console.warn(`[startup] could not clear the interrupted-run marker for ${repoRoot}:`, err),
  );
}

async function listTasksOrEmpty(repoRoot: string): Promise<Task[]> {
  try {
    return await listTasks(repoRoot);
  } catch {
    return [];
  }
}
