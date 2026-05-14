import {
  isMidMerge,
  mainIsAncestorOfWorktree,
  resyncWithMainAndFinalize,
  type ResyncFinalizeOptions,
} from '../worktree.js';
import { type Task } from '../tasks.js';
import { release, tryAcquire } from '../mergeLocks.js';
import { finishTaskAndCheckIntegrity } from './repoIntegrity.js';
import {
  handleResyncOutcome,
  respawnResolverForFlaggedConflict,
} from './resolverSpawn.js';
import { type MergeRun } from './state.js';
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
  let outcome: ProcessOutcome = { kind: 'spawned-resolver' };
  try {
    await respawnResolverForFlaggedConflict(task, run, runCtx);
  } catch (err) {
    console.error(`[merge-run] re-spawn for ${task.id} failed:`, err);
    run.errored.push({
      taskId: task.id,
      error: `re-spawn resolver failed: ${(err as Error).message}`,
    });
    outcome = { kind: 'errored' };
  }
  run.processed += 1;
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
  let outcome: ProcessOutcome;
  if (!tryAcquire(task.id)) {
    console.warn(`[merge-run] task ${task.id} lock held — skipping`);
    run.errored.push({
      taskId: task.id,
      error: 'merge lock held by another caller; skipped',
    });
    outcome = { kind: 'errored' };
  } else {
    try {
      const resyncOutcome = await resyncWithMainAndFinalize(
        task,
        runCtx.backendOrigin,
        mergeRunResyncOptions(task, { assumeMainAlreadyIncorporated: true }),
      );
      outcome = await handleResyncOutcome(task, run, runCtx, resyncOutcome);
    } catch (err) {
      console.error(`[merge-run] uncaught error finalizing ${task.id}:`, err);
      run.errored.push({
        taskId: task.id,
        error: (err as Error).message ?? 'unknown error',
      });
      outcome = { kind: 'errored' };
    } finally {
      release(task.id);
    }
  }

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
