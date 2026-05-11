// Backend-driven "merge all ready" runs.
//
// The frontend used to drive a sequential loop over /api/tasks/:id/merge
// in JS — closing the browser tab killed the loop, the first conflict
// halted everything, and there was no way to surface progress. This
// module owns the loop server-side: a run iterates through every task
// the user wants to merge, calls the same merge logic /api/tasks/:id/merge
// uses, and emits events on a WS so the UI can render progress live.
//
// One active run per project; concurrent run-starts on the same project
// are rejected. Inside a run, each task acquires the per-task lock from
// mergeLocks.ts, so a manual /merge call landing during a run can't race.

import { restoreSnapshot, type SnapshotHandle } from './worktree.js';
import { listTasks, type Task } from './tasks.js';
import { canonicalProjectPath } from './projectPath.js';
import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from './projectRunLock.js';
import { generateMergeRunId } from './ids.js';
import { processTarget } from './mergeRuns/processTarget.js';
import { runPreflight } from './mergeRuns/preflight.js';
import {
  cancelRunInState,
  createRunState,
  getActiveRunForProjectFromState,
  getRunFromState,
  notify,
  signalConflictWaiterInState,
  snapshot,
  subscribeToRunState,
  type MergeRun,
  type MergeRunEvent,
} from './mergeRuns/state.js';

export type {
  MergeRun,
  MergeRunErrorEntry,
  MergeRunEvent,
  MergeRunStatus,
} from './mergeRuns/state.js';

const runState = createRunState();

export function subscribe(fn: (ev: MergeRunEvent) => void): () => void {
  return subscribeToRunState(runState, fn);
}

export function getRun(id: string): MergeRun | null {
  return getRunFromState(runState, id);
}

export function getActiveRunForProject(projectPath: string): MergeRun | null {
  return getActiveRunForProjectFromState(runState, projectPath);
}

export function cancelRun(id: string): boolean {
  return cancelRunInState(runState, id);
}

// Called by /complete (and /merged) after a resolver Claude finalizes a
// conflict task. Unblocks the in-process merge run that spawned the resolver
// so it can continue to the next task with an up-to-date main HEAD.
// Returns true if a waiter was signalled; false means the run was killed
// by a backend restart and the caller should start a fresh run instead.
export function signalConflictWaiter(taskId: string): boolean {
  return signalConflictWaiterInState(runState, taskId);
}

async function runTeardown(
  projectPath: string,
  run: MergeRun,
  runSnapshot: SnapshotHandle,
  targets: Task[],
  backendOrigin: string,
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

  // If tasks became ready_to_merge while this run was processing its
  // snapshot, they were never in `targets` and are still waiting. Auto-
  // restart so they get picked up without requiring a manual merge-all click.
  if (!run.cancelRequested) {
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
        startMergeRun(projectPath, backendOrigin).catch(() => {});
      }
    } catch {
      // best-effort; failure just means the user sees the remaining tasks
      // at ready_to_merge and can trigger merge-all manually
    }
  }
}

export async function startMergeRun(
  projectPath: string,
  backendOrigin: string,
): Promise<MergeRun> {
  projectPath = canonicalProjectPath(projectPath);
  for (const r of runState.runs.values()) {
    if (r.projectPath === projectPath && r.status === 'running') {
      throw new Error('A merge run is already in progress for this project.');
    }
  }

  // Cross-process gate. If another Lattice process is already merging
  // this project (the lattice-on-lattice scenario, or two sibling
  // installations sharing a repo), bail before we begin: holding a stale
  // run object plus running snapshot/FF concurrently with a sibling
  // process is the configuration that produced prior `.git` deletions.
  let projectLock: ProjectRunLockHandle;
  try {
    projectLock = await acquireProjectRunLock(projectPath, 'merge-run');
  } catch (err) {
    if (err instanceof ProjectRunLockedError) {
      throw new Error(err.message);
    }
    throw err;
  }

  const tasks = await listTasks(projectPath);
  // Include conflict-flagged tasks too — the per-task loop knows how to
  // re-attempt them (resolver Claude may have already finished and
  // committed; Lattice just needs to re-sync and finalize). The old
  // `&& !t.conflict` filter stranded conflict tasks across server
  // restarts: a "merge all" click would skip them entirely.
  const targets = tasks
    .filter((t) => t.status === 'ready_to_merge')
    .sort((a, b) => a.createdAt - b.createdAt);

  const run: MergeRun = {
    id: generateMergeRunId(),
    projectPath,
    status: 'running',
    startedAt: Date.now(),
    total: targets.length,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: [],
    cancelRequested: false,
  };
  runState.runs.set(run.id, run);
  notify(runState, { type: 'started', run: snapshot(run) });

  // Run the worker async. Fire-and-forget; consumers track via WS / GET.
  (async () => {
    console.log(`[merge-run] ${run.id} started — ${targets.length} task(s) to merge`);

    const { runSnapshot, baselineHead } = await runPreflight(projectPath, run);
    const runCtx = {
      projectPath,
      backendOrigin,
      baselineHead,
      state: runState,
    };

    for (const seed of targets) {
      const action = await processTarget(seed, run, runCtx);
      if (action === 'halt') break;
    }

    await runTeardown(projectPath, run, runSnapshot, targets, backendOrigin);
    finishRun(run);
  })()
    .catch((err) => {
      console.error('[mergeRuns] run worker crashed', err);
      run.status = 'errored';
      run.finishedAt = Date.now();
      notify(runState, { type: 'completed', run: snapshot(run) });
    })
    .finally(() => projectLock.release().catch(() => undefined));

  return snapshot(run);
}

function finishRun(run: MergeRun): void {
  run.status = run.cancelRequested ? 'cancelled' : 'completed';
  run.finishedAt = Date.now();
  run.current = undefined;
  console.log(`[merge-run] ${run.id} ${run.status} — merged=${run.merged.length} conflicts=${run.conflicted.length} errors=${run.errored.length}`);
  if (run.errored.length > 0) {
    for (const e of run.errored) console.error(`[merge-run] error on ${e.taskId}: ${e.error}`);
  }
  notify(runState, {
    type: run.cancelRequested ? 'cancelled' : 'completed',
    run: snapshot(run),
  });
}

// Called by /api/merge-runs/:id/stash-resolved after Claude resolves the
// post-run stash-pop conflict. Marks the run completed and notifies clients.
export function completeRunAfterStashResolution(id: string): boolean {
  const run = runState.runs.get(id);
  if (!run || run.status !== 'running') return false;
  console.log(`[merge-run] ${id} completing after stash resolution`);
  finishRun(run);
  return true;
}
