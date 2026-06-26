import {
  buildConflictResolveCommand,
  writeMergeInstructions,
  type ResyncOutcome,
} from '../worktree.js';
import { listConflictedFiles } from '../worktree/state.js';
import { type Task } from '../tasks.js';
import { release } from '../mergeLocks.js';
import { queuedCreateSession } from '../queuedCreateSession.js';
import {
  notify,
  registerConflictWaiter,
  type MergeRun,
  type RunState,
} from './state.js';
import type {
  ProcessOutcome,
  ProcessTargetContext,
} from './processTarget.js';

// Park the merge-run worker on the conflict waiter for `taskId` until the
// resolver's Stop hook signals it — WITHOUT holding the per-task merge lock.
//
// The caller (processTarget / tryFinalizeAfterResolverFinished) acquired that
// lock to serialize the in-worktree git merge that produced this conflict. By
// the time we reach the wait that git work is done; from here we only block on
// the resolver. We MUST drop the lock before waiting, because the resolver's
// /complete -> finalizeResolvedTask takes the SAME per-task lock to re-sync, FF
// main, and signal this very waiter. Parking while still holding it makes that
// finalize lose the tryAcquire race, return 'already-finalizing' WITHOUT
// signalling, and this promise never resolves — deadlocking the run (and
// stranding the resolver pty, which only the finalize's worktree cleanup tears
// down). registerConflictWaiter records the waiter entry synchronously, so
// releasing the lock immediately after it can never miss a signal that races
// in. (The mid-merge re-spawn path parks lock-free for the same reason.)
export async function parkOnConflictResolver(
  state: RunState,
  runId: string,
  taskId: string,
): Promise<void> {
  const waitForResolver = registerConflictWaiter(state, runId, taskId);
  release(taskId);
  await waitForResolver;
}

type ResolverSpawnInput = {
  task: Task;
  run: MergeRun;
  runCtx: ProcessTargetContext;
  cwd: string;
  command: string;
  conflictedFiles: string[];
};

export type ResolverSpawnResult =
  | { kind: 'spawned'; serverId: string | undefined }
  | { kind: 'spawn-error'; error: string };

async function spawnResolverAndNotifyConflict({
  task,
  run,
  runCtx,
  cwd,
  command,
  conflictedFiles,
  onBeforeNotify,
}: ResolverSpawnInput & { onBeforeNotify?: () => void }): Promise<ResolverSpawnResult> {
  // Routed through the spawn queue on the `priority` band: a resolver may
  // dip into PRIORITY_RESERVE headroom above softCap, so an in-flight merge
  // run can always get its resolver even when batch slots are full. A CAP
  // rejection is retried inside the queue (await simply takes longer); only
  // a genuine terminal-server failure surfaces as `{ error }` below.
  const sess = await queuedCreateSession({
    kind: 'merge-run-resolver',
    priority: 'priority',
    dedupeKey: `mr-resolver:${task.id}`,
    opts: { cwd, initialCommand: command, projectPath: task.projectPath },
  });
  // queuedCreateSession returns { error } when the terminal-server can't
  // start (we hit this when a missing dist asset killed terminal-server's
  // boot mid-merge-run). Without surfacing this, the caller would still
  // notify(conflict) and registerConflictWaiter — blocking the run forever
  // on a resolver Claude that was never actually spawned. Fail the task
  // instead so the run can move on / be retried after terminal-server is
  // healthy again.
  if ('error' in sess) {
    console.error(
      `[merge-run] resolver spawn failed for task ${task.id}: ${sess.error}`,
    );
    return { kind: 'spawn-error', error: sess.error };
  }
  onBeforeNotify?.();
  notify(runCtx.state, {
    type: 'conflict',
    runId: run.id,
    projectPath: runCtx.projectPath,
    taskId: task.id,
    command,
    cwd,
    conflictedFiles,
    serverId: sess.id,
  });
  return { kind: 'spawned', serverId: sess.id };
}

export async function spawnAndRecord(
  input: ResolverSpawnInput,
): Promise<ResolverSpawnResult> {
  return spawnResolverAndNotifyConflict({
    ...input,
    onBeforeNotify: () => {
      input.run.conflicted.push(input.task.id);
    },
  });
}

export async function recordAndSpawn(
  input: ResolverSpawnInput,
): Promise<ResolverSpawnResult> {
  const result = await spawnResolverAndNotifyConflict(input);
  // Only mark the task conflicted on a successful spawn — a spawn-error
  // is bubbled up as a run error so the conflict counter doesn't double
  // up with the errored counter for the same task.
  if (result.kind === 'spawned') {
    input.run.conflicted.push(input.task.id);
  }
  return result;
}

export async function respawnResolverForFlaggedConflict(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<ResolverSpawnResult> {
  const conflictedFiles = await listConflictedFiles(task.worktreePath!);
  const { relativePath } = await writeMergeInstructions(
    task,
    task.branch!,
    conflictedFiles,
    runCtx.backendOrigin,
    task.worktreePath!,
  );
  const command = buildConflictResolveCommand(relativePath);
  return spawnAndRecord({
    task,
    run,
    runCtx,
    cwd: task.worktreePath!,
    command,
    conflictedFiles,
  });
}

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
): Promise<ProcessOutcome> {
  if (outcome.kind === 'finalized') {
    run.merged.push(task.id);
    return { kind: 'finalized' };
  }

  if (outcome.kind === 'stash-conflict') {
    const spawn = await recordAndSpawn({
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
    const spawn = await recordAndSpawn({
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
    await parkOnConflictResolver(runCtx.state, run.id, task.id);
    console.log(`[merge-run] conflict resolver done for task ${task.id} — resuming run`);
    return { kind: 'awaiting-resolver' };
  }

  run.errored.push({ taskId: task.id, error: outcome.message });
  return { kind: 'errored' };
}
