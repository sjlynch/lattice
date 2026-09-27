import type { Response } from 'express';
import { queuedCreateSession } from '../../queuedCreateSession.js';
import {
  buildConflictResolveCommand,
  writeMergeInstructions,
  type ResyncOutcome,
} from '../../worktree.js';
import type { MergeReadyTask } from './manualMergeTypes.js';
import { mergeTerminalLabel } from '../../terminalRegistry/labels.js';
import { terminalRegistry } from '../../terminalRegistry/store.js';

type ResolverSessionPayload = {
  stashConflict?: true;
  command: string;
  cwd: string;
  conflictedFiles?: string[];
};

export async function respondResolverSession(
  res: Response,
  task: MergeReadyTask,
  payload: ResolverSessionPayload,
): Promise<Response> {
  // `priority` band — a manual-merge conflict resolver, like a merge-run
  // resolver, may use PRIORITY_RESERVE headroom above softCap.
  const sess = await queuedCreateSession({
    kind: 'manual-merge-resolver',
    priority: 'priority',
    dedupeKey: `mm-resolver:${task.id}`,
    opts: {
      cwd: payload.cwd,
      initialCommand: payload.command,
      projectPath: task.projectPath,
      // A merge-conflict resolver runs IN the task's worktree: it gets the
      // task's reduced Lattice toolset (LATTICE_TASK_ID) and the task-worktree
      // MCP scope. A stash/snapshot resolver runs at the project root and gets
      // neither — the scope must never reach a project-root cwd.
      ...(payload.stashConflict
        ? {}
        : { taskId: task.id, mcpScope: 'task-worktree' as const }),
      registry: {
        owner: 'merge',
        kind: 'merge',
        taskId: task.id,
        label: mergeTerminalLabel(task.title, task.id),
      },
    },
  });
  const serverId = 'id' in sess ? sess.id : undefined;
  const terminalId = 'id' in sess ? sess.terminalId : undefined;
  // No pty → the UI must say so rather than open a serverless terminal (which
  // would bypass the spawn chokepoint: no MCP scope, no system prompt, no
  // registry record). The conflict itself stands; a re-click retries.
  const resolverError = 'error' in sess ? sess.error : undefined;
  if (resolverError) {
    console.warn(`[merge] task ${task.id}: resolver pre-spawn failed: ${resolverError}`);
  }
  if (payload.stashConflict) {
    return res.json({
      merged: false,
      stashConflict: true,
      command: payload.command,
      cwd: payload.cwd,
      conflictedFiles: payload.conflictedFiles,
      serverId,
      terminalId,
      ...(resolverError ? { resolverError } : {}),
    });
  }
  if (payload.conflictedFiles) {
    return res.json({
      merged: false,
      conflict: true,
      command: payload.command,
      cwd: payload.cwd,
      conflictedFiles: payload.conflictedFiles,
      serverId,
      terminalId,
      ...(resolverError ? { resolverError } : {}),
    });
  }
  return res.json({
    merged: false,
    conflict: true,
    command: payload.command,
    cwd: payload.cwd,
    serverId,
    terminalId,
  });
}

export async function respondMergeOutcome(
  res: Response,
  task: MergeReadyTask,
  outcome: ResyncOutcome,
): Promise<Response> {
  if (outcome.kind === 'finalized') {
    return res.json({ merged: true });
  }
  if (outcome.kind === 'stash-conflict') {
    return respondResolverSession(res, task, {
      stashConflict: true,
      command: outcome.resolveCommand,
      cwd: outcome.cwd,
      conflictedFiles: outcome.conflictedFiles,
    });
  }
  if (outcome.kind === 'merge-conflict') {
    return respondResolverSession(res, task, {
      command: outcome.command,
      cwd: outcome.cwd,
      conflictedFiles: outcome.conflictedFiles,
    });
  }
  return res.status(500).json({ error: outcome.message });
}

export async function respondExistingConflictInstructions(
  res: Response,
  task: MergeReadyTask,
  backendOrigin: string,
): Promise<Response> {
  const { relativePath } = await writeMergeInstructions(
    task,
    task.branch,
    [],
    backendOrigin,
    task.worktreePath,
  );
  return respondResolverSession(res, task, {
    command: buildConflictResolveCommand(relativePath),
    cwd: task.worktreePath,
  });
}

// A resolver is already working in this task's worktree (the user clicked the
// conflict pill / Merge again while it runs): hand back THAT pty instead of
// spawning a second agent into the same merge. MERGE_INSTRUCTIONS.md is left
// as the live resolver is reading it. `terminalId` is its durable tab, when the
// registry knows it, so the UI focuses that tab rather than adding one.
export async function respondLiveResolver(
  res: Response,
  task: MergeReadyTask,
  serverId: string,
): Promise<Response> {
  const terminalId = await terminalRegistry
    .list(task.projectPath)
    .then((records) => records.find((r) => r.serverId === serverId)?.id)
    .catch(() => undefined);
  return res.json({
    merged: false,
    conflict: true,
    command: buildConflictResolveCommand('MERGE_INSTRUCTIONS.md'),
    cwd: task.worktreePath,
    serverId,
    terminalId,
    existingResolver: true,
  });
}
