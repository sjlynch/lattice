import { prepareMergeConflictOutcome } from '../../worktree.js';
import { listConflictedFiles } from '../../worktree/state.js';
import { type Task } from '../../tasks.js';
import { queuedCreateSession } from '../../queuedCreateSession.js';
import { proxyListSessionsOrNull } from '../../terminalServerClient.js';
import { agentHarnessForCommand } from '../../harnesses.js';
import path from 'node:path';
import { notify, type MergeRun } from '../state.js';
import type { ProcessTargetContext } from '../processTarget.js';
import { mergeRunCancellation } from '../cancellation.js';

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
    dedupeKey: `mr-resolver:${run.id}:${task.id}`,
    signal: mergeRunCancellation(run),
    timeoutMs: 10 * 60_000,
    opts: { cwd, initialCommand: command, projectPath: task.projectPath },
  }).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
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
  (run.resolvers ??= {})[task.id] = { sessionId: sess.id, lastProgressAt: Date.now() };
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
  deps = { listSessions: proxyListSessionsOrNull, listConflictedFiles, prepareMergeConflictOutcome, spawnAndRecord },
): Promise<ResolverSpawnResult> {
  // The backend may have restarted while its detached resolver PTY survived.
  // Adopt that agent instead of starting two writers in the same worktree.
  // An unavailable probe is not proof that it died: fail this attempt safely.
  const sessions = await deps.listSessions();
  if (!sessions) return { kind: 'spawn-error', error: 'Cannot verify whether the previous resolver is still running' };
  const normalizeCwd = (cwd: string) => {
    const normalized = path.resolve(cwd);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const existing = sessions.find((candidate) => {
    const session = candidate as { id?: unknown; cwd?: unknown; initialCommand?: unknown } | null;
    return session && typeof session.id === 'string' && typeof session.cwd === 'string'
      && typeof session.initialCommand === 'string' && agentHarnessForCommand(session.initialCommand)
      && /\bMERGE_INSTRUCTIONS\.md\b/i.test(session.initialCommand)
      && normalizeCwd(session.cwd) === normalizeCwd(task.worktreePath!);
  }) as { id: string } | undefined;
  const conflictedFiles = await deps.listConflictedFiles(task.worktreePath!);
  // markConflict:false — this task is already conflict-flagged (that's why we
  // re-spawn), so re-flagging would needlessly reset conflictStartedAt.
  const { command } = await deps.prepareMergeConflictOutcome({
    task,
    branch: task.branch!,
    conflictedFiles,
    backendOrigin: runCtx.backendOrigin,
    worktreePath: task.worktreePath!,
    markConflict: false,
  });
  if (existing) {
    const prior = [...runCtx.state.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => r.resolvers?.[task.id]).find((r) => r?.sessionId === existing.id);
    (run.resolvers ??= {})[task.id] = prior ? { ...prior } : { sessionId: existing.id, lastProgressAt: Date.now() };
    run.conflicted.push(task.id);
    notify(runCtx.state, {
      type: 'conflict', runId: run.id, projectPath: runCtx.projectPath,
      taskId: task.id, command, cwd: task.worktreePath!, conflictedFiles, serverId: existing.id,
    });
    console.log(`[merge-run] task ${task.id}: reattached existing resolver ${existing.id}`);
    return { kind: 'spawned', serverId: existing.id };
  }
  return deps.spawnAndRecord({
    task,
    run,
    runCtx,
    cwd: task.worktreePath!,
    command,
    conflictedFiles,
  });
}
