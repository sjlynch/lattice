import {
  isMidMerge,
  mainIsAncestorOfWorktree,
  resyncWithMainAndFinalize,
  type ResyncFinalizeOptions,
} from '../worktree.js';
import { type Task } from '../tasks.js';
import { finishTaskAndCheckIntegrity } from './repoIntegrity.js';
import {
  handleResyncOutcome,
  respawnResolverForFlaggedConflict,
} from './resolverSpawn.js';
import { type MergeRun } from './state.js';
import { awaitResolverWaiter } from './waiterLiveness.js';
import { recoverAbandonedResolverTask } from './abandonedResolver.js';
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

export async function tryRespawnMidMergeResolver(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<ProcessOutcome> {
  console.log(`[merge-run] task ${task.id} mid-merge — re-spawning resolver`);
  let outcome: ProcessOutcome = { kind: 'awaiting-resolver' };
  let spawned = false;
  try {
    const result = await respawnResolverForFlaggedConflict(task, run, runCtx);
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
    } else {
      spawned = true;
    }
  } catch (err) {
    console.error(`[merge-run] re-spawn for ${task.id} failed:`, err);
    run.errored.push({
      taskId: task.id,
      error: `re-spawn resolver failed: ${(err as Error).message}`,
    });
    outcome = { kind: 'errored' };
  }
  run.processed += 1;

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
    );
    if (reason === 'signalled') {
      console.log(`[merge-run] re-spawned conflict resolver done for task ${task.id} — resuming run`);
    } else {
      console.warn(
        `[merge-run] re-spawned conflict resolver for task ${task.id} ${reason === 'timeout' ? 'wait timed out' : 'pty died'} — recovering and continuing`,
      );
      run.errored.push({
        taskId: task.id,
        error: `re-spawned conflict resolver ${reason} (no completion callback); left at ready_to_merge`,
      });
      await recoverAbandonedResolverTask(task);
    }
  }
  return outcome;
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
): Promise<FlaggedConflictTaskResult> {
  if (!task.conflict) return fallthrough();

  if (await isMidMerge(task.worktreePath!)) {
    return handled(await tryRespawnMidMergeResolver(task, run, runCtx));
  }

  return tryFinalizeAfterResolverFinished(
    task,
    run,
    runCtx,
    mergeRunResyncOptions,
  );
}
