import type { Response } from 'express';
import { queuedCreateSession } from '../../queuedCreateSession.js';
import {
  buildConflictResolveCommand,
  writeMergeInstructions,
  type ResyncOutcome,
} from '../../worktree.js';
import type { MergeReadyTask } from './manualMergeTypes.js';
import { mergeTerminalLabel } from '../../terminalRegistry/labels.js';

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
  if (payload.stashConflict) {
    return res.json({
      merged: false,
      stashConflict: true,
      command: payload.command,
      cwd: payload.cwd,
      conflictedFiles: payload.conflictedFiles,
      serverId,
      terminalId,
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
