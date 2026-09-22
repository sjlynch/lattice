import {
  isMidMerge,
  mainIsAncestorOfWorktree,
  resyncWithMainAndFinalize,
  type ResyncFinalizeOptions,
} from '../worktree.js';
import { getTask, type Task } from '../tasks.js';
import { proxyKillSession } from '../terminalProxy.js';
import { finishTaskAndCheckIntegrity } from './repoIntegrity.js';
import {
  handleResyncOutcome,
  respawnResolverForFlaggedConflict,
} from './resolverSpawn.js';
import { abandonConflictWaiter, registerConflictWaiter, type MergeRun } from './state.js';
import { awaitResolverWaiter } from './waiterLiveness.js';
import { preserveResolverAfterWaitFailure } from './resolverWaitFailure.js';
import { withMergeLock } from './withMergeLock.js';
import type {
  ProcessOutcome,
  ProcessTargetContext,
} from './processTarget.js';

type MergeRunResyncOptionsFactory = (
  task: Task,
  opts?: { assumeMainAlreadyIncorporated?: boolean },
) => ResyncFinalizeOptions;

export type FlaggedConflictTaskResult =
  | { action: 'fallthrough' }
  | { action: 'handled'; outcome: ProcessOutcome };

function fallthrough(): FlaggedConflictTaskResult {
  return { action: 'fallthrough' };
}

function handled(outcome: ProcessOutcome): FlaggedConflictTaskResult {
  return { action: 'handled', outcome };
}

// Injectable seams for the unit test (production defaults below).
export type RespawnMidMergeDeps = {
  respawn: typeof respawnResolverForFlaggedConflict;
  getTask: typeof getTask;
  killSession: typeof proxyKillSession;
};

const productionRespawnDeps: RespawnMidMergeDeps = {
  respawn: respawnResolverForFlaggedConflict,
  getTask,
  killSession: proxyKillSession,
};

export async function tryRespawnMidMergeResolver(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
  deps: RespawnMidMergeDeps = productionRespawnDeps,
): Promise<ProcessOutcome> {
  console.log(`[merge-run] task ${task.id} mid-merge — recovering resolver`);
  // A surviving resolver may complete during session probing / instruction
  // repair. Register first so its callback cannot disappear before we park.
  const waiter = registerConflictWaiter(runCtx.state, run.id, task.id);
  let outcome: ProcessOutcome = { kind: 'awaiting-resolver' };
  let spawned = false;
  let serverId: string | undefined;
  try {
    const result = await deps.respawn(task, run, runCtx);
    if (result.kind === 'spawn-error') {
      // terminal-server is unavailable — no resolver was actually spawned.
      // Surface as an error so the run moves on (task stays at
      // ready_to_merge + conflict:true; retrying once terminals are back
      // will pick it up).
      run.errored.push({
        taskId: task.id,
        error: `resolver spawn failed (terminals unavailable): ${result.error}`,
      });
      outcome = { kind: 'errored' };
    } else if (!(await stillAwaitingResolution(task.id, deps))) {
      // This path parks lock-free, so nothing stopped a `/merge-aborted`
      // (the Resolving-strip Cancel, a give-up resolver) from landing while
      // the spawn sat in the queue: it cleared `task.conflict` and ran
      // `git merge --abort` in the worktree. The resolver that just came up
      // would be told to resolve a merge that no longer exists — and its
      // Stop-hook /complete would land on a plain ready_to_merge task. Kill
      // it and honour the abort (task stays at ready_to_merge for the next
      // merge-all, exactly as /merge-aborted intends).
      console.warn(
        `[merge-run] task ${task.id}: conflict was cleared while the resolver re-spawn was queued — ` +
          `killing the freshly spawned resolver ${result.serverId ?? '(unknown session)'} and treating it as aborted`,
      );
      if (result.serverId && !(await deps.killSession(result.serverId))) {
        console.warn(`[merge-run] task ${task.id}: could not confirm kill of resolver ${result.serverId}`);
      }
      run.errored.push({
        taskId: task.id,
        error: 'conflict resolution was aborted while its resolver re-spawn was queued; task left at ready_to_merge',
      });
      outcome = { kind: 'errored' };
    } else {
      spawned = true;
      serverId = result.serverId;
    }
  } catch (err) {
    console.error(`[merge-run] re-spawn for ${task.id} failed:`, err);
    run.errored.push({
      taskId: task.id,
      error: `re-spawn resolver failed: ${(err as Error).message}`,
    });
    outcome = { kind: 'errored' };
  }
  // `processed` is bumped by the caller's finishTaskAndCheckIntegrity (see
  // handleFlaggedConflictTask), after the park — like the fresh-conflict path.

  if (spawned) {
    // Block the run until the re-spawned resolver finishes — same contract
    // as the fresh-conflict path in resolverSpawn.handleResyncOutcome.
    // Without this, an upstream caller (the workflow Merge step's drain
    // loop) sees the task still in ready_to_merge after the merge run
    // completes, starts another merge run, and respawns a second resolver
    // for the same task. The signal comes from /complete (via
    // signalConflictWaiter) once the resolver finishes finalizing, or from
    // cancelRun on explicit cancellation.
    //
    // awaitResolverWaiter also backstops a resolver that dies with no callback
    // (crash / killed pty / missed Stop hook): it returns 'resolver-dead' /
    // 'timeout' instead of hanging the run forever and wedging the project lock.
    // This path parks lock-free (no merge lock held), so there's nothing extra
    // to release. task.worktreePath is the resolver's cwd for the liveness probe.
    console.log(`[merge-run] waiting for re-spawned conflict resolver on task ${task.id}...`);
    const reason = await awaitResolverWaiter(
      runCtx.state,
      run.id,
      task.id,
      task.worktreePath,
      undefined,
      undefined,
      waiter,
      serverId,
    );
    if (reason === 'signalled') {
      console.log(`[merge-run] re-spawned conflict resolver done for task ${task.id} — resuming run`);
    } else {
      console.warn(
        `[merge-run] re-spawned conflict resolver for task ${task.id}: ${reason} — preserving work and stopping the run`,
      );
      preserveResolverAfterWaitFailure(run, task.id, reason);
    }
  } else {
    abandonConflictWaiter(runCtx.state, task.id, run.id);
  }
  return outcome;
}

// Re-read the task after an await of unbounded length: still the same
// conflict-flagged ready_to_merge task we were asked to recover?
async function stillAwaitingResolution(taskId: string, deps: RespawnMidMergeDeps): Promise<boolean> {
  const fresh = await deps.getTask(taskId);
  return !!fresh && fresh.status === 'ready_to_merge' && !!fresh.conflict;
}

export async function tryFinalizeAfterResolverFinished(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
  mergeRunResyncOptions: MergeRunResyncOptionsFactory,
): Promise<FlaggedConflictTaskResult> {
  console.log(
    `[merge-run] task ${task.id} flagged conflict but worktree is clean — re-syncing`,
  );

  // Fix 1: if main is already an ancestor of the worktree branch HEAD,
  // the resolver committed against the current main and nothing else has
  // advanced main since. Skip the re-merge and finalize directly — the
  // re-merge would be a no-op and can spuriously conflict if main moved
  // due to a concurrent backend restart (the Lattice-on-itself scenario).
  let mainAlreadyMerged = false;
  try {
    mainAlreadyMerged = await mainIsAncestorOfWorktree(
      task.projectPath,
      task.worktreePath!,
    );
  } catch (err) {
    console.warn(
      `[merge-run] ancestor check for ${task.id} failed (will re-merge): ${(err as Error).message}`,
    );
  }

  if (!mainAlreadyMerged) {
    // main has advanced since the resolver committed; fall through to the
    // normal merge path to absorb the new commits (may or may not conflict).
    return fallthrough();
  }

  console.log(
    `[merge-run] task ${task.id}: main already incorporated in branch — finalizing directly`,
  );
  const locked = await withMergeLock(task, run, 'finalizing', async (lock) => {
    const resyncOutcome = await resyncWithMainAndFinalize(
      task,
      runCtx.backendOrigin,
      mergeRunResyncOptions(task, { assumeMainAlreadyIncorporated: true }),
    );
    return handleResyncOutcome(task, run, runCtx, resyncOutcome, lock);
  });
  const outcome: ProcessOutcome =
    locked.kind === 'lock-unavailable' ? { kind: 'errored' } : locked.outcome;

  const checkedOutcome = await finishTaskAndCheckIntegrity(run, runCtx, task.id, outcome);
  return handled(checkedOutcome);
}

export async function handleFlaggedConflictTask(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
  mergeRunResyncOptions: MergeRunResyncOptionsFactory,
  deps: { isMidMerge: typeof isMidMerge; respawn: RespawnMidMergeDeps } = {
    isMidMerge,
    respawn: productionRespawnDeps,
  },
): Promise<FlaggedConflictTaskResult> {
  if (!task.conflict) return fallthrough();

  if (await deps.isMidMerge(task.worktreePath!)) {
    // The re-spawned resolver's finalize fast-forwards main, so this path
    // needs the same after-task circuit breaker (and progress bump) as every
    // other one — it used to skip it, so a damaged repo was only noticed
    // after the NEXT task had already run against it.
    const outcome = await tryRespawnMidMergeResolver(task, run, runCtx, deps.respawn);
    return handled(await finishTaskAndCheckIntegrity(run, runCtx, task.id, outcome));
  }

  return tryFinalizeAfterResolverFinished(
    task,
    run,
    runCtx,
    mergeRunResyncOptions,
  );
}
