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

import { listTasks, type Task } from './tasks.js';
import {
  isRepoMaintenanceRunning,
  runRepoMaintenance,
  waitForRepoMaintenance,
} from './worktree/repoMaintenance.js';
import { RepoMaintenanceBusyError, type ProjectRunLockHandle } from './projectRunLock.js';
import { processTarget } from './mergeRuns/processTarget.js';
import { runPreflight } from './mergeRuns/preflight.js';
import {
  createRunRecord,
  loadRunTargets,
  initializeRunState,
} from './mergeRuns/lifecycle.js';
import {
  runPostMergeHook,
  runTeardown,
} from './mergeRuns/teardown.js';
import { finalizeMergeRun } from './mergeRuns/finalize.js';
import { claimRecoveryAttempt, resetRecoveryAttempt } from './recovery/retryBudget.js';
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

// How long after a merge run ends before its git housekeeping (see finalize below).
const REPO_MAINTENANCE_DELAY_MS = 60_000;

export type StartMergeRunOptions = {
  lockMode?: MergeRunLockMode;
  automaticRecovery?: boolean;
  // Set only by an explicit user retry, never by resolver callbacks/auto-restart.
  resetRecoveryBudget?: boolean;
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

// Live merge runs in this process and the conflict resolvers each is parked
// on. Read by the restart drain's lock-holder report (restartDrain/lockHolders.ts).
export function listLiveMergeRunResolverWaits(): Array<{ run: MergeRun; resolverTaskIds: string[] }> {
  return runState.liveRunsWithResolverWaits();
}

// Called by /complete (and /merged) after a resolver Claude finalizes a
// conflict task. Unblocks the in-process merge run that spawned the resolver
// so it can continue to the next task with an up-to-date main HEAD.
// Returns true if a waiter was signalled; false means the run was killed
// by a backend restart and the caller should start a fresh run instead.
export function signalConflictWaiter(taskId: string): boolean {
  return signalConflictWaiterInState(runState, taskId);
}

// Fire-and-forget restart for tasks that became ready_to_merge mid-run. Invoked
// by finalizeMergeRun's `restart` callback, which fires it only after the run's
// project lock is released and the run is off 'running' — so this fresh start
// clears initializeRunState's 409 / cross-process-lock gates instead of being
// rejected and swallowed here.
function restartMergeRun(projectPath: string, backendOrigin: string): void {
  startMergeRunAfterMaintenance(projectPath, backendOrigin).catch(() => {});
}

// Retries allowed after a housekeeping refusal. Another gc can only begin a
// minute after a merge run ENDS, so more than one retry is already rare; the
// bound just keeps a misbehaving wait from spinning.
const MAINTENANCE_RETRY_LIMIT = 3;

// startMergeRun for a callback that restarts the run on behalf of the
// remaining Ready-to-Merge tasks (/stash-resolved, a resolver's finalize, the
// mid-run restart above). Those callers swallow a throw as "another run is
// active and owns the rest" — but a refusal because the post-run `git gc` is in
// flight means nothing owns the rest, and nothing retries after the gc. So wait
// for the housekeeping to finish and retry; every other refusal (a run already
// active, another process's lock) is rethrown unchanged for the caller.
export async function startMergeRunAfterMaintenance(
  projectPath: string,
  backendOrigin: string,
  options: StartMergeRunOptions = {},
  deps: {
    start?: (projectPath: string, backendOrigin: string, options: StartMergeRunOptions) => Promise<MergeRun>;
    waitForMaintenance?: (projectPath: string) => Promise<boolean>;
  } = {},
): Promise<MergeRun> {
  const start = deps.start ?? ((p, o, opts) => startMergeRun(p, o, opts));
  const wait = deps.waitForMaintenance ?? ((p) => waitForRepoMaintenance(p));
  for (let attempt = 0; ; attempt++) {
    try {
      return await start(projectPath, backendOrigin, options);
    } catch (err) {
      if (!(err instanceof RepoMaintenanceBusyError) || attempt >= MAINTENANCE_RETRY_LIMIT) throw err;
      console.log(`[merge-run] ${projectPath}: git housekeeping in flight — restarting the merge run once it finishes`);
      if (!(await wait(projectPath))) throw err;
    }
  }
}

export async function startMergeRun(
  projectPath: string,
  backendOrigin: string,
  options: StartMergeRunOptions = {},
  deps = { listTasks, runPreflight, processTarget },
): Promise<MergeRun> {
  const lockMode = options.lockMode ?? 'acquire';

  // Never start merging alongside the post-run `git gc --auto`: this run's git
  // processes would map the packs a repack is replacing, and on Windows the old
  // ones then can't be deleted (a full leftover copy per maintenance). The gc
  // also holds the run lock, which catches the window before it takes it; this
  // refuses for the whole housekeeping with a message that says why. 'inherit'
  // callers (the workflow Merge step) already waited for it before their lock.
  if (lockMode === 'acquire' && isRepoMaintenanceRunning(projectPath)) {
    throw new RepoMaintenanceBusyError();
  }

  // Lock acquisition + active-run (409) detection. Throws before any run
  // record exists if a run is already in progress (in- or cross-process).
  const { projectPath: canonicalPath, projectLock } = await initializeRunState(
    runState,
    projectPath,
    lockMode,
  );

  const targets = await loadRunTargets(canonicalPath, projectLock, deps.listTasks);

  await chargeRecoveryBudget(canonicalPath, targets, options, projectLock);

  const run = createRunRecord(targets, canonicalPath);
  runState.runs.set(run.id, run);
  // Mark live BEFORE the first emit: from here until the worker's finalize
  // resolves, this record is backed by a worker, and the orphan reaper must
  // leave it alone.
  runState.markRunLive(run.id);
  notify(runState, { type: 'started', run: snapshot(run) });

  // Run the worker async. Fire-and-forget; consumers track via WS / GET.
  //
  // finalizeMergeRun guarantees the auto-restart (for tasks that became ready
  // mid-run) fires only AFTER the project lock is released and finishRun has
  // moved this run off 'running'. Restarting inline from runTeardown — while
  // this run still held the lock and was still 'running' — was rejected by the
  // fresh run's 409 / lock gates and silently swallowed.
  void finalizeMergeRun({
    body: () => runMergeRunBody(
      run, targets, { projectPath: canonicalPath, backendOrigin }, deps, lockMode,
    ),
    onError: (err) => {
      console.error('[mergeRuns] run worker crashed', err);
      run.status = 'errored';
      run.errored.push({ taskId: '(run)', error: err instanceof Error ? err.message : String(err) });
      run.finishedAt = Date.now();
      notify(runState, { type: 'completed', run: snapshot(run) });
    },
    releaseLock: async () => {
      await projectLock?.release().catch(() => undefined);
    },
    restart: () => restartMergeRun(canonicalPath, backendOrigin),
  }).finally(() => {
    // Worker is gone (completed, cancelled, or crashed). Any `running` record
    // left behind is now reapable rather than a permanent block.
    runState.markRunSettled(run.id);
    scheduleRepoMaintenance(canonicalPath);
  });

  return snapshot(run);
}

// Charge only after winning project ownership. A second backend losing the
// lock is contention, not a failed recovery attempt. Explicit retries remain
// available and grant the next interruption a fresh recovery allowance.
// No worker exists yet, so a refusal releases the lock here before rethrowing
// (an automatic recovery also leaves an errored "(recovery)" run saying why).
async function chargeRecoveryBudget(
  canonicalPath: string,
  targets: Task[],
  options: StartMergeRunOptions,
  projectLock: ProjectRunLockHandle | null,
): Promise<void> {
  try {
    if (options.automaticRecovery) {
      const budget = await claimRecoveryAttempt(canonicalPath, 'merge', targets.map((t) => t.id).sort().join('|'));
      if (budget.paused) throw new Error(budget.paused);
    } else if (options.resetRecoveryBudget) {
      // An unreadable/invalid journal is preserved on purpose and refuses
      // AUTOMATIC replay — but it must not also block the user's explicit
      // retry, which is the documented way out of a paused recovery. Leave
      // the file alone (it stays refusing automatic replay) and merge.
      await resetRecoveryAttempt(canonicalPath, 'merge').catch((err: unknown) => {
        console.warn(
          `[merge-run] could not reset the recovery budget for ${canonicalPath} (continuing with the explicit run):`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  } catch (err) {
    if (options.automaticRecovery) {
      const stopped = createRunRecord(targets, canonicalPath);
      stopped.status = 'errored';
      stopped.finishedAt = Date.now();
      stopped.errored.push({ taskId: '(recovery)', error: err instanceof Error ? err.message : String(err) });
      runState.runs.set(stopped.id, stopped);
      notify(runState, { type: 'completed', run: snapshot(stopped) });
    }
    await projectLock?.release();
    throw err;
  }
}

type MergeRunBodyContext = { projectPath: string; backendOrigin: string };

// The worker body finalizeMergeRun drives: preflight, the per-target loop,
// teardown (always, even when the loop throws), the post-merge hook, then
// finishRun. Resolves to whether tasks became ready mid-run, i.e. a fresh run
// is owed once this one's lock is released.
async function runMergeRunBody(
  run: MergeRun,
  targets: Task[],
  ctx: MergeRunBodyContext,
  deps: { runPreflight: typeof runPreflight; processTarget: typeof processTarget },
  lockMode: MergeRunLockMode,
): Promise<boolean> {
  console.log(`[merge-run] ${run.id} started — ${targets.length} task(s) to merge`);

  const { runSnapshot, baselineHead } = await deps.runPreflight(ctx.projectPath, run);
  const runCtx = {
    projectPath: ctx.projectPath,
    backendOrigin: ctx.backendOrigin,
    baselineHead,
    state: runState,
  };

  let shouldRestart = false;
  try {
    for (const seed of targets) {
      const action = await deps.processTarget(seed, run, runCtx);
      if (action === 'halt') break;
    }
  } finally {
    // Unexpected task/read errors must restore the user's captured edits
    // in this session too, before the outer worker releases run.lock.
    shouldRestart = await runTeardown(
      ctx.projectPath, run, runSnapshot, targets, lockMode,
    );
  }
  await runPostMergeHook(run, ctx.projectPath, ctx.backendOrigin);
  finishRun(run);
  return shouldRestart;
}

// Git housekeeping, once, now that the burst of merges is over — auto-gc
// is off for every git Lattice runs (worktree/gitAutoGc.ts). After a quiet
// minute (a workflow's Merge step often starts the next run right away,
// and then this skips), and never while the project is merging.
function scheduleRepoMaintenance(canonicalPath: string): void {
  const maintenance = setTimeout(() => {
    void runRepoMaintenance(canonicalPath, { isBusy: (p) => getActiveRunForProject(p) !== null });
  }, REPO_MAINTENANCE_DELAY_MS);
  maintenance.unref?.();
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
