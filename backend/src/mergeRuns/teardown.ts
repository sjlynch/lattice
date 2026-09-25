// Post-run teardown for the merge-all engine: snapshot restore, the auto-restart
// branch for tasks that became ready mid-run, and the post-merge hook gate.
//
// Extracted from startMergeRun (../mergeRuns.ts). The safety invariants live
// here now and must be preserved exactly: the snapshot is restored promptly
// in-session even on cancel (NOT deferred to the next boot — see below),
// auto-restart only when this run owns its lock, and the hook gate only when
// something actually landed in qa.

import { restoreSnapshot, type SnapshotHandle } from '../worktree.js';
import { listTasks, type Task } from '../tasks.js';
import { runPostMergeHookGate } from '../postMergeHooks.js';
import { clearPostMergeHookOwed, isPostMergeHookOwed } from '../postMergeHooks/owed.js';
import type { MergeRunLockMode } from '../mergeRuns.js';
import type { MergeRun } from './state.js';

// Restore the user's working-tree snapshot, then decide whether a fresh run
// must be auto-started for any task that became ready while this run was in
// flight. Returns that decision rather than restarting inline — the actual
// restart is deferred by the orchestrator (mergeRuns.ts finalizeMergeRun) until
// after finishRun and the project lock release, so the fresh run's in-process /
// cross-process gates pass instead of being rejected and swallowed.
export async function runTeardown(
  projectPath: string,
  run: MergeRun,
  runSnapshot: SnapshotHandle,
  targets: Task[],
  lockMode: MergeRunLockMode,
): Promise<boolean> {
  // Post-run snapshot restore — on cancel too. This used to be gated on
  // `!run.cancelRequested`, deferring a cancelled run's snapshot to the next
  // boot's recoverPendingSnapshots. That deferral was a data-loss trap: the
  // user watches their uncommitted changes vanish (we reset the tree to take
  // the snapshot), and if they re-do or edit those files before the backend
  // restarts (routine in dev under tsc -w) the deferred boot restore silently
  // clobbers the redo. Restoring here, in-session, closes that window — the
  // current tree may include newer edits. Restore checks the current version,
  // preserves divergent dirty work, and retains captured conflict copies.
  // Partial restores and failures become visible run errors.
  if (runSnapshot.dir) {
    const kind = run.cancelRequested ? 'cancelled run ' : 'run ';
    console.log(`[merge-run] restoring ${kind}snapshot → ${runSnapshot.dir}`);
    try {
      const restored = await restoreSnapshot(runSnapshot, projectPath);
      if (restored.status === 'partial') {
        run.errored.push({ taskId: '(snapshot)', error: `Snapshot only partly restored; newer edits preserved and captured copies retained at ${runSnapshot.dir}` });
        console.warn(`[merge-run] snapshot partly restored; retained at ${runSnapshot.dir}`);
      } else {
        console.log(`[merge-run] snapshot restored`);
      }
    } catch (err) {
      run.errored.push({ taskId: '(snapshot)', error: `Snapshot restore failed; captured work retained at ${runSnapshot.dir}: ${(err as Error).message}` });
      console.warn('[merge-run] post-run snapshot restore failed (continuing):', err);
    }
  }

  return autoRestartIfNeeded(projectPath, run, targets, lockMode);
}

// If tasks became ready_to_merge while this run was processing its
// snapshot, they were never in `targets` and are still waiting. Report that a
// fresh run should pick them up (the orchestrator starts it after the lock is
// released) so they merge without a manual merge-all click.
//
// Skip the auto-restart when this run inherited its lock — the workflow
// Merge control step holds the lock and is responsible for looping through
// any remaining ready_to_merge tasks itself. A restart here would try to
// acquire its own lock (with the default 'acquire' mode) and fail since the
// workflow still holds it.
//
// `listTasksFn` is injectable purely for tests; production always uses the real
// listTasks.
export async function autoRestartIfNeeded(
  projectPath: string,
  run: MergeRun,
  targets: Task[],
  lockMode: MergeRunLockMode,
  listTasksFn: typeof listTasks = listTasks,
): Promise<boolean> {
  if (run.cancelRequested || lockMode === 'inherit') return false;
  try {
    const allTasks = await listTasksFn(projectPath);
    const seenIds = new Set(targets.map((t) => t.id));
    const newReady = allTasks.filter(
      (t) => t.status === 'ready_to_merge' && !t.conflict && !seenIds.has(t.id),
    );
    if (newReady.length > 0) {
      console.log(
        `[merge-run] ${newReady.length} task(s) became ready_to_merge during this run — will auto-restart after lock release`,
      );
      return true;
    }
    return false;
  } catch {
    // best-effort; failure just means the user sees the remaining tasks
    // at ready_to_merge and can trigger merge-all manually
    return false;
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
  // `isPostMergeHookOwed`: a merge that landed before a restart whose hook
  // never fired — the resumed run then merges nothing itself (see
  // postMergeHooks/owed.ts).
  if (!run.cancelRequested && (run.merged.length > 0 || await isPostMergeHookOwed(projectPath))) {
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
  } else if (run.cancelRequested) {
    // A cancelled / halted run deliberately fires no hook — settle the debt
    // its merges recorded too, or the next boot would fire it after all.
    await clearPostMergeHookOwed(projectPath);
  }
}
