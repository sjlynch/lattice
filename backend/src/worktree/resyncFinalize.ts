// Shared "merge current main into a task worktree, then finalize" plumbing.
// Callers keep their own HTTP / merge-run response shaping; this module only
// performs the common git + task-state transitions.

import { updateTask, type Task } from '../tasks.js';
import { buildConflictResolveCommand } from './commands.js';
import { finalizeMergedTask, type FinalizeOutcome } from './finalize.js';
import { writeMergeInstructions } from './instructions.js';
import { mergeWorktreeInRepo, type MergeOutcome } from './merge.js';
import { mainIsAncestorOfWorktree } from './state.js';

export type ResyncOutcome =
  | { kind: 'finalized' }
  | {
      kind: 'merge-conflict';
      conflictedFiles: string[];
      relativePath: string;
      command: string;
      cwd: string;
    }
  | {
      kind: 'stash-conflict';
      cwd: string;
      resolveCommand: string;
      conflictedFiles: string[];
      message: string;
    }
  | { kind: 'error'; phase: 'merge' | 'finalize'; message: string };

export type ResyncFinalizeOptions = {
  // If true, first check whether main is already an ancestor of the worktree
  // branch. When it is, skip mergeWorktreeInRepo and finalize immediately.
  skipIfMainAncestor?: boolean;
  // Same short-circuit, but for callers that already performed the ancestor
  // check and need to preserve their exact logging / fallthrough behavior.
  assumeMainAlreadyIncorporated?: boolean;
  onMainAlreadyIncorporated?: () => void;
  onAncestorCheckError?: (err: unknown) => void;
  onBeforeMerge?: () => void;
  onMergeResult?: (result: MergeOutcome) => void;
  onBeforeWriteMergeInstructions?: (
    result: Extract<MergeOutcome, { status: 'conflict' }>,
  ) => void;
  onBeforeFinalize?: () => void;
  onFinalizeResult?: (result: FinalizeOutcome) => void;
};

function finalizeFailureMessage(
  fin: Extract<FinalizeOutcome, { ok: false }>,
): string {
  if ('error' in fin) return fin.error;
  return `Stash-pop conflict on ${fin.stashConflict.length} file(s) — Claude resolver spawned`;
}

export async function resyncWithMainAndFinalize(
  task: Task,
  backendOrigin: string,
  opts: ResyncFinalizeOptions = {},
): Promise<ResyncOutcome> {
  if (!task.branch || !task.worktreePath) {
    return {
      kind: 'error',
      phase: 'merge',
      message: 'task missing branch/worktree info',
    };
  }

  let mainAlreadyIncorporated = !!opts.assumeMainAlreadyIncorporated;
  if (!mainAlreadyIncorporated && opts.skipIfMainAncestor) {
    try {
      mainAlreadyIncorporated = await mainIsAncestorOfWorktree(
        task.projectPath,
        task.worktreePath,
      );
    } catch (err) {
      opts.onAncestorCheckError?.(err);
      mainAlreadyIncorporated = false;
    }
    if (mainAlreadyIncorporated) {
      opts.onMainAlreadyIncorporated?.();
    }
  }

  let mergeResult: MergeOutcome = { status: 'clean' };
  if (!mainAlreadyIncorporated) {
    opts.onBeforeMerge?.();
    mergeResult = await mergeWorktreeInRepo(
      task.projectPath,
      task.branch,
      task.worktreePath,
      task.id,
      backendOrigin,
      task.title,
    );
    opts.onMergeResult?.(mergeResult);
  }

  if (mergeResult.status === 'conflict') {
    opts.onBeforeWriteMergeInstructions?.(mergeResult);
    const { relativePath } = await writeMergeInstructions(
      task,
      task.branch,
      mergeResult.conflictedFiles,
      backendOrigin,
      task.worktreePath,
    );
    await updateTask(task.id, {
      conflict: true,
      conflictStartedAt: Date.now(),
    });
    return {
      kind: 'merge-conflict',
      conflictedFiles: mergeResult.conflictedFiles,
      relativePath,
      command: buildConflictResolveCommand(relativePath),
      cwd: task.worktreePath,
    };
  }

  if (mergeResult.status === 'error') {
    return { kind: 'error', phase: 'merge', message: mergeResult.message };
  }

  opts.onBeforeFinalize?.();
  const fin = await finalizeMergedTask(task, backendOrigin);
  opts.onFinalizeResult?.(fin);
  if (fin.ok) {
    return { kind: 'finalized' };
  }
  const message = finalizeFailureMessage(fin);
  if ('stashConflict' in fin) {
    return {
      kind: 'stash-conflict',
      cwd: fin.cwd,
      resolveCommand: fin.resolveCommand,
      conflictedFiles: fin.stashConflict,
      message,
    };
  }
  return { kind: 'error', phase: 'finalize', message };
}
