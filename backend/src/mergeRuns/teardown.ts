// Post-run teardown for the merge-all engine: snapshot restore, the auto-restart
// branch for tasks that became ready mid-run, and the post-merge hook gate.
//
// Extracted from startMergeRun (../mergeRuns.ts). The safety invariants live
// here now and must be preserved exactly: snapshot restore only on a
// non-cancelled run (a cancelled run keeps its snapshot for recoverPending-
// Snapshots on next boot), auto-restart only when this run owns its lock, and
// the hook gate only when something actually landed in qa.

import { restoreSnapshot, type SnapshotHandle } from '../worktree.js';
import { listTasks, type Task } from '../tasks.js';
import { runPostMergeHookGate } from '../postMergeHooks.js';
import type { MergeRunLockMode } from '../mergeRuns.js';
import type { MergeRun } from './state.js';

// Fire-and-forget restart hook. Passed in by the orchestrator (rather than
// importing startMergeRun directly) so teardown stays free of a runtime cycle
// back to ../mergeRuns.ts.
export type RestartMergeRun = (projectPath: string, backendOrigin: string) => void;

// Restore the user's working-tree snapshot, then auto-restart for any task that
// became ready while this run was in flight.
export async function runTeardown(
  projectPath: string,
  run: MergeRun,
  runSnapshot: SnapshotHandle,
  targets: Task[],
  backendOrigin: string,
  lockMode: MergeRunLockMode,
  restart: RestartMergeRun,
): Promise<void> {
  // Post-run snapshot restore. Only when the loop ran to completion
  // (not on cancel) — a cancelled run leaves the snapshot in place so
  // the user's mods aren't blasted with whatever partial state the FFs
  // left. The snapshot dir survives across server restarts and
  // recoverPendingSnapshots will restore it on next boot.
  //
  // Unlike the prior stash-based path, restore here can never produce a
  // "conflict" outcome — copy-based restore is last-writer-wins on
  // overlap. Conservative: the user's snapshotted files always win
  // over whatever the FF brought in. Worst case is a dirty working
  // tree the user can review with `git status` / `git diff`.
  if (runSnapshot.dir && !run.cancelRequested) {
    console.log(`[merge-run] restoring run snapshot → ${runSnapshot.dir}`);
    try {
      await restoreSnapshot(runSnapshot, projectPath);
      console.log(`[merge-run] snapshot restored`);
    } catch (err) {
      console.warn('[merge-run] post-run snapshot restore failed (continuing):', err);
    }
  }

  await autoRestartIfNeeded(projectPath, run, targets, backendOrigin, lockMode, restart);
}

// If tasks became ready_to_merge while this run was processing its
// snapshot, they were never in `targets` and are still waiting. Auto-
// restart so they get picked up without requiring a manual merge-all click.
//
// Skip the auto-restart when this run inherited its lock — the workflow
// Merge control step holds the lock and is responsible for looping through
// any remaining ready_to_merge tasks itself. A fire-and-forget restart here
// would try to acquire its own lock (with the default 'acquire' mode) and
// fail since the workflow still holds it.
export async function autoRestartIfNeeded(
  projectPath: string,
  run: MergeRun,
  targets: Task[],
  backendOrigin: string,
  lockMode: MergeRunLockMode,
  restart: RestartMergeRun,
): Promise<void> {
  if (!run.cancelRequested && lockMode !== 'inherit') {
    try {
      const allTasks = await listTasks(projectPath);
      const seenIds = new Set(targets.map((t) => t.id));
      const newReady = allTasks.filter(
        (t) => t.status === 'ready_to_merge' && !t.conflict && !seenIds.has(t.id),
      );
      if (newReady.length > 0) {
        console.log(
          `[merge-run] ${newReady.length} task(s) became ready_to_merge during this run — auto-restarting`,
        );
        restart(projectPath, backendOrigin);
      }
    } catch {
      // best-effort; failure just means the user sees the remaining tasks
      // at ready_to_merge and can trigger merge-all manually
    }
  }
}

// Post-merge hook gate. Fires once per merge run when at least one task
// actually landed in qa, the run wasn't cancelled, and the user has a
// hook prompt configured. Blocks finishRun (and therefore any WS
// subscriber / workflow merge step awaiting 'completed') until the hook
// agent calls back. A no-op if the hook isn't configured.
export async function runPostMergeHook(
  run: MergeRun,
  projectPath: string,
  backendOrigin: string,
): Promise<void> {
  if (!run.cancelRequested && run.merged.length > 0) {
    try {
      await runPostMergeHookGate({
        projectPath,
        backendOrigin,
        trigger: 'merge-run',
      });
    } catch (err) {
      console.warn(
        '[merge-run] post-merge hook gate threw (continuing to finish run):',
        err,
      );
    }
  }
}
