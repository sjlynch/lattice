import { type ResyncOutcome } from '../../worktree.js';
import { type Task } from '../../tasks.js';
import { type MergeLockToken } from '../../mergeLocks.js';
import { type MergeRun } from '../state.js';
import type {
  ProcessOutcome,
  ProcessTargetContext,
} from '../processTarget.js';
import { recordAndSpawn } from './spawn.js';
import { parkOnConflictResolver } from './park.js';
import { preserveResolverAfterWaitFailure } from '../resolverWaitFailure.js';

function recordSpawnError(
  run: MergeRun,
  task: Task,
  error: string,
): ProcessOutcome {
  run.errored.push({
    taskId: task.id,
    error: `resolver spawn failed (terminals unavailable): ${error}`,
  });
  return { kind: 'errored' };
}

export async function handleResyncOutcome(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
  outcome: ResyncOutcome,
  lock?: MergeLockToken,
  deps = { recordAndSpawn, parkOnConflictResolver },
): Promise<ProcessOutcome> {
  if (outcome.kind === 'finalized') {
    run.merged.push(task.id);
    return { kind: 'finalized' };
  }

  if (outcome.kind === 'stash-conflict') {
    const spawn = await deps.recordAndSpawn({
      task,
      run,
      runCtx,
      cwd: outcome.cwd,
      command: outcome.resolveCommand,
      conflictedFiles: outcome.conflictedFiles,
    });
    if (spawn.kind === 'spawn-error') {
      // Stash conflict with no resolver is unrecoverable mid-run (main
      // can't FF until the stash is resolved). Halt the run and record
      // the error so the user sees what went wrong.
      run.cancelRequested = true;
      return recordSpawnError(run, task, spawn.error);
    }
    // Stop the run — subsequent tasks can't FF until the stash conflict
    // is resolved. /stash-resolved will auto-restart the run.
    run.cancelRequested = true;
    return { kind: 'spawned-resolver' };
  }

  if (outcome.kind === 'merge-conflict') {
    const spawn = await deps.recordAndSpawn({
      task,
      run,
      runCtx,
      cwd: outcome.cwd,
      command: outcome.command,
      conflictedFiles: outcome.conflictedFiles,
    });
    if (spawn.kind === 'spawn-error') {
      // No resolver Claude is running — registering a conflict waiter
      // would block the run forever (the /complete callback that would
      // signal it can only come from a Stop hook on a real session).
      // Skip the task and let the run continue; the task stays at
      // ready_to_merge + conflict:true and a fresh merge-all retry can
      // pick it back up once terminals are working.
      return recordSpawnError(run, task, spawn.error);
    }

    // Fix 2: block the run worker until the resolver's Stop hook fires and
    // /complete signals us. This keeps conflict resolution sequential so each
    // subsequent task's merge sees the latest main HEAD — preventing the
    // "stale resolution" race where resolver B commits against main@v1 and
    // resolver A's finalize has already advanced main to v2 with overlapping
    // changes, forcing a second conflict round.
    //
    // The signal comes from /complete (via signalConflictWaiter) after
    // finalizeMergedTask succeeds, or after a re-sync conflict re-queues the
    // task, or from cancelRunInState on explicit cancellation. In all cases
    // the run simply continues to the next task; run.cancelRequested is the
    // definitive halt signal.
    //
    // parkOnConflictResolver drops the per-task merge lock before waiting — the
    // resolver's /complete finalize needs that same lock, so holding it across
    // the wait would deadlock the run (see the helper's note).
    console.log(`[merge-run] waiting for conflict resolver on task ${task.id}...`);
    if (!lock) {
      throw new Error(
        `merge-conflict wait for ${task.id} requires the caller's merge lock token`,
      );
    }
    const reason = await deps.parkOnConflictResolver(
      runCtx.state,
      run.id,
      lock,
      task.worktreePath,
      spawn.serverId,
    );
    if (reason === 'signalled') {
      console.log(`[merge-run] conflict resolver done for task ${task.id} — resuming run`);
    } else {
      // The waiter no longer owns the task lock; preserve the interrupted
      // resolution and stop instead of racing a late finalize or new resolver.
      console.warn(
        `[merge-run] conflict resolver for task ${task.id}: ${reason} — preserving work and stopping the run`,
      );
      preserveResolverAfterWaitFailure(run, task.id, reason);
    }
    // The lock was already released inside parkOnConflictResolver, so this
    // outcome must stay 'awaiting-resolver' (tells withMergeLock not to
    // double-release) regardless of how the wait ended.
    return { kind: 'awaiting-resolver' };
  }

  run.errored.push({ taskId: task.id, error: outcome.message });
  return { kind: 'errored' };
}
