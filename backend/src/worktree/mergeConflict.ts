// Shared preparation for a merge-conflict resolver hand-off. Three sites —
// finalize.ts (retry re-sync conflict), resyncFinalize.ts (first-pass conflict),
// and mergeRuns/resolverSpawn.ts (merge-run re-spawn) — all run the same
// sequence before shaping their own outcome object: write MERGE_INSTRUCTIONS.md,
// (optionally) flag the task as conflicted, and build the resolver command. Each
// caller keeps its distinct return shape; only this preparation is deduped here.

import { updateTask, type Task } from '../tasks.js';
import { buildConflictResolveCommand } from './commands.js';
import { writeMergeInstructions } from './instructions.js';

export async function markTaskMergeConflict(taskId: string): Promise<void> {
  await updateTask(taskId, {
    conflict: true,
    conflictStartedAt: Date.now(),
  });
}

export type PreparedMergeConflict = {
  conflictedFiles: string[];
  relativePath: string;
  command: string;
  cwd: string;
};

export type PrepareMergeConflictInput = {
  task: Task;
  branch: string;
  conflictedFiles: string[];
  backendOrigin: string;
  worktreePath: string;
  // Whether to flag the task as conflicted (sets conflict + conflictStartedAt).
  // The two finalize sites detect the conflict here and flag it; the merge-run
  // re-spawn path operates on an already-flagged task, so it opts out to avoid
  // resetting conflictStartedAt. Defaults to true.
  markConflict?: boolean;
};

export async function prepareMergeConflictOutcome(
  input: PrepareMergeConflictInput,
): Promise<PreparedMergeConflict> {
  const { relativePath } = await writeMergeInstructions(
    input.task,
    input.branch,
    input.conflictedFiles,
    input.backendOrigin,
    input.worktreePath,
  );
  if (input.markConflict ?? true) {
    await markTaskMergeConflict(input.task.id);
  }
  return {
    conflictedFiles: input.conflictedFiles,
    relativePath,
    command: buildConflictResolveCommand(relativePath),
    cwd: input.worktreePath,
  };
}
