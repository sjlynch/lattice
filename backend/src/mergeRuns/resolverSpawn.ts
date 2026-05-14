import {
  buildConflictResolveCommand,
  writeMergeInstructions,
  type ResyncOutcome,
} from '../worktree.js';
import { listConflictedFiles } from '../worktree/state.js';
import { type Task } from '../tasks.js';
import { proxyCreateSession } from '../terminalProxy.js';
import {
  notify,
  registerConflictWaiter,
  type MergeRun,
} from './state.js';
import type {
  ProcessOutcome,
  ProcessTargetContext,
} from './processTarget.js';

type ResolverSpawnInput = {
  task: Task;
  run: MergeRun;
  runCtx: ProcessTargetContext;
  cwd: string;
  command: string;
  conflictedFiles: string[];
};

async function spawnResolverAndNotifyConflict({
  task,
  run,
  runCtx,
  cwd,
  command,
  conflictedFiles,
  onBeforeNotify,
}: ResolverSpawnInput & { onBeforeNotify?: () => void }): Promise<void> {
  const sess = await proxyCreateSession({
    cwd,
    initialCommand: command,
    projectPath: task.projectPath,
  });
  onBeforeNotify?.();
  notify(runCtx.state, {
    type: 'conflict',
    runId: run.id,
    projectPath: runCtx.projectPath,
    taskId: task.id,
    command,
    cwd,
    conflictedFiles,
    serverId: 'id' in sess ? sess.id : undefined,
  });
}

export async function spawnAndRecord(input: ResolverSpawnInput): Promise<void> {
  await spawnResolverAndNotifyConflict({
    ...input,
    onBeforeNotify: () => {
      input.run.conflicted.push(input.task.id);
    },
  });
}

export async function recordAndSpawn(input: ResolverSpawnInput): Promise<void> {
  input.run.conflicted.push(input.task.id);
  await spawnResolverAndNotifyConflict(input);
}

export async function respawnResolverForFlaggedConflict(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<void> {
  const conflictedFiles = await listConflictedFiles(task.worktreePath!);
  const { relativePath } = await writeMergeInstructions(
    task,
    task.branch!,
    conflictedFiles,
    runCtx.backendOrigin,
    task.worktreePath!,
  );
  const command = buildConflictResolveCommand(relativePath);
  await spawnAndRecord({
    task,
    run,
    runCtx,
    cwd: task.worktreePath!,
    command,
    conflictedFiles,
  });
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
    await recordAndSpawn({
      task,
      run,
      runCtx,
      cwd: outcome.cwd,
      command: outcome.resolveCommand,
      conflictedFiles: outcome.conflictedFiles,
    });
    // Stop the run — subsequent tasks can't FF until the stash conflict
    // is resolved. /stash-resolved will auto-restart the run.
    run.cancelRequested = true;
    return { kind: 'spawned-resolver' };
  }

  if (outcome.kind === 'merge-conflict') {
    await recordAndSpawn({
      task,
      run,
      runCtx,
      cwd: outcome.cwd,
      command: outcome.command,
      conflictedFiles: outcome.conflictedFiles,
    });

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
    console.log(`[merge-run] waiting for conflict resolver on task ${task.id}...`);
    await registerConflictWaiter(runCtx.state, run.id, task.id);
    console.log(`[merge-run] conflict resolver done for task ${task.id} — resuming run`);
    return { kind: 'awaiting-resolver' };
  }

  run.errored.push({ taskId: task.id, error: outcome.message });
  return { kind: 'errored' };
}
