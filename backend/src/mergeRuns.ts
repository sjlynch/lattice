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

import { listTasks } from './tasks.js';
import { processTarget } from './mergeRuns/processTarget.js';
import { runPreflight } from './mergeRuns/preflight.js';
import {
  createRunRecord,
  filterAndSortTargets,
  initializeRunState,
} from './mergeRuns/lifecycle.js';
import {
  runPostMergeHook,
  runTeardown,
} from './mergeRuns/teardown.js';
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

// Lock-acquisition policy for startMergeRun.
//   - 'acquire' (default): grab the cross-process project run-lock for the
//     duration of the run; release in the worker's finally.
//   - 'inherit': caller already holds the lock and is responsible for
//     releasing it. Used by the workflow Merge control step, which holds
//     the lock for the whole step (Phase A + Phase B) and passes through
//     here so this call doesn't deadlock against itself.
export type MergeRunLockMode = 'acquire' | 'inherit';

export type StartMergeRunOptions = {
  lockMode?: MergeRunLockMode;
};

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

// Fire-and-forget restart used by teardown's auto-restart branch. Passed in
// (rather than referenced directly inside teardown) so teardown.ts doesn't take
// a runtime dependency back on this module.
function restartMergeRun(projectPath: string, backendOrigin: string): void {
  startMergeRun(projectPath, backendOrigin).catch(() => {});
}

export async function startMergeRun(
  projectPath: string,
  backendOrigin: string,
  options: StartMergeRunOptions = {},
): Promise<MergeRun> {
  const lockMode = options.lockMode ?? 'acquire';

  // Lock acquisition + active-run (409) detection. Throws before any run
  // record exists if a run is already in progress (in- or cross-process).
  const { projectPath: canonicalPath, projectLock } = await initializeRunState(
    runState,
    projectPath,
    lockMode,
  );

  const tasks = await listTasks(canonicalPath);
  const targets = filterAndSortTargets(tasks);

  const run = createRunRecord(targets, canonicalPath);
  runState.runs.set(run.id, run);
  notify(runState, { type: 'started', run: snapshot(run) });

  // Run the worker async. Fire-and-forget; consumers track via WS / GET.
  (async () => {
    console.log(`[merge-run] ${run.id} started — ${targets.length} task(s) to merge`);

    const { runSnapshot, baselineHead } = await runPreflight(canonicalPath, run);
    const runCtx = {
      projectPath: canonicalPath,
      backendOrigin,
      baselineHead,
      state: runState,
    };

    for (const seed of targets) {
      const action = await processTarget(seed, run, runCtx);
      if (action === 'halt') break;
    }

    await runTeardown(
      canonicalPath,
      run,
      runSnapshot,
      targets,
      backendOrigin,
      lockMode,
      restartMergeRun,
    );
    await runPostMergeHook(run, canonicalPath, backendOrigin);
    finishRun(run);
  })()
    .catch((err) => {
      console.error('[mergeRuns] run worker crashed', err);
      run.status = 'errored';
      run.finishedAt = Date.now();
      notify(runState, { type: 'completed', run: snapshot(run) });
    })
    .finally(() => projectLock?.release().catch(() => undefined));

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
