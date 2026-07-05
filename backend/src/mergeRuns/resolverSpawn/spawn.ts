import { prepareMergeConflictOutcome } from '../../worktree.js';
import { listConflictedFiles } from '../../worktree/state.js';
import { type Task } from '../../tasks.js';
import { queuedCreateSession } from '../../queuedCreateSession.js';
import { notify, type MergeRun } from '../state.js';
import type { ProcessTargetContext } from '../processTarget.js';

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
  // markConflict:false — this task is already conflict-flagged (that's why we
  // re-spawn), so re-flagging would needlessly reset conflictStartedAt.
  const { command } = await prepareMergeConflictOutcome({
    task,
    branch: task.branch!,
    conflictedFiles,
    backendOrigin: runCtx.backendOrigin,
    worktreePath: task.worktreePath!,
    markConflict: false,
  });
  return spawnAndRecord({
    task,
    run,
    runCtx,
    cwd: task.worktreePath!,
    command,
    conflictedFiles,
  });
}
