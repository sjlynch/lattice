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

type ResyncContext = {
  task: Task;
  backendOrigin: string;
  branch: string;
  worktreePath: string;
};

function buildResyncContext(
  task: Task,
  backendOrigin: string,
): ResyncContext | ResyncOutcome {
  if (!task.branch || !task.worktreePath) {
    return {
      kind: 'error',
      phase: 'merge',
      message: 'task missing branch/worktree info',
    };
  }
  return {
    task,
    backendOrigin,
    branch: task.branch,
    worktreePath: task.worktreePath,
  };
}

function isResyncOutcome(
  value: ResyncContext | ResyncOutcome,
): value is ResyncOutcome {
  return 'kind' in value;
}

function finalizeFailureMessage(
  fin: Extract<FinalizeOutcome, { ok: false }>,
): string {
  if ('error' in fin) return fin.error;
  if ('stashConflict' in fin) {
    return `Stash-pop conflict on ${fin.stashConflict.length} file(s) — Claude resolver spawned`;
  }
  // merge-conflict is intercepted by the caller before this runs; handled
  // here only so the union stays exhaustive.
  return `Re-sync with main conflicted on ${fin.mergeConflict.length} file(s) — Claude resolver spawned`;
}

async function mainAlreadyIncorporated(
  ctx: ResyncContext,
  opts: ResyncFinalizeOptions,
): Promise<boolean> {
  if (opts.assumeMainAlreadyIncorporated) return true;
  if (!opts.skipIfMainAncestor) return false;

  try {
    const incorporated = await mainIsAncestorOfWorktree(
      ctx.task.projectPath,
      ctx.worktreePath,
    );
    if (incorporated) {
      opts.onMainAlreadyIncorporated?.();
    }
    return incorporated;
  } catch (err) {
    opts.onAncestorCheckError?.(err);
    return false;
  }
}

async function mergeMainIntoWorktree(
  ctx: ResyncContext,
  opts: ResyncFinalizeOptions,
): Promise<MergeOutcome> {
  opts.onBeforeMerge?.();
  const mergeResult = await mergeWorktreeInRepo(
    ctx.task.projectPath,
    ctx.branch,
    ctx.worktreePath,
    ctx.task.id,
    ctx.backendOrigin,
    ctx.task.title,
  );
  opts.onMergeResult?.(mergeResult);
  return mergeResult;
}

async function mergeIfNeeded(
  ctx: ResyncContext,
  opts: ResyncFinalizeOptions,
): Promise<MergeOutcome> {
  if (await mainAlreadyIncorporated(ctx, opts)) {
    return { status: 'clean' };
  }
  return mergeMainIntoWorktree(ctx, opts);
}

async function markTaskMergeConflict(taskId: string): Promise<void> {
  await updateTask(taskId, {
    conflict: true,
    conflictStartedAt: Date.now(),
  });
}

async function writeMergeConflictResyncOutcome(
  ctx: ResyncContext,
  mergeResult: Extract<MergeOutcome, { status: 'conflict' }>,
  opts: ResyncFinalizeOptions,
): Promise<ResyncOutcome> {
  opts.onBeforeWriteMergeInstructions?.(mergeResult);
  const { relativePath } = await writeMergeInstructions(
    ctx.task,
    ctx.branch,
    mergeResult.conflictedFiles,
    ctx.backendOrigin,
    ctx.worktreePath,
  );
  await markTaskMergeConflict(ctx.task.id);
  return {
    kind: 'merge-conflict',
    conflictedFiles: mergeResult.conflictedFiles,
    relativePath,
    command: buildConflictResolveCommand(relativePath),
    cwd: ctx.worktreePath,
  };
}

async function handleMergeResult(
  ctx: ResyncContext,
  mergeResult: MergeOutcome,
  opts: ResyncFinalizeOptions,
): Promise<ResyncOutcome | null> {
  if (mergeResult.status === 'conflict') {
    return writeMergeConflictResyncOutcome(ctx, mergeResult, opts);
  }
  if (mergeResult.status === 'error') {
    return { kind: 'error', phase: 'merge', message: mergeResult.message };
  }
  return null;
}

function shapeMergeConflictFinalizeOutcome(
  fin: Extract<FinalizeOutcome, { ok: false; mergeConflict: string[] }>,
): ResyncOutcome {
  // The retry re-sync inside finalize conflicted (a sibling task advanced
  // main onto an overlapping hunk). finalize already wrote
  // MERGE_INSTRUCTIONS.md + flagged the task; surface it as a resolvable
  // merge-conflict so the caller spawns a second resolver, exactly like a
  // first-pass conflict.
  return {
    kind: 'merge-conflict',
    conflictedFiles: fin.mergeConflict,
    relativePath: fin.relativePath,
    command: fin.resolveCommand,
    cwd: fin.cwd,
  };
}

function shapeStashConflictFinalizeOutcome(
  fin: Extract<FinalizeOutcome, { ok: false; stashConflict: string[] }>,
  message: string,
): ResyncOutcome {
  return {
    kind: 'stash-conflict',
    cwd: fin.cwd,
    resolveCommand: fin.resolveCommand,
    conflictedFiles: fin.stashConflict,
    message,
  };
}

function shapeFinalizeFailure(
  fin: Extract<FinalizeOutcome, { ok: false }>,
): ResyncOutcome {
  if ('mergeConflict' in fin) return shapeMergeConflictFinalizeOutcome(fin);
  const message = finalizeFailureMessage(fin);
  if ('stashConflict' in fin) return shapeStashConflictFinalizeOutcome(fin, message);
  return { kind: 'error', phase: 'finalize', message };
}

async function finalizeAfterCleanMerge(
  ctx: ResyncContext,
  opts: ResyncFinalizeOptions,
): Promise<ResyncOutcome> {
  opts.onBeforeFinalize?.();
  const fin = await finalizeMergedTask(ctx.task, ctx.backendOrigin);
  opts.onFinalizeResult?.(fin);
  if (fin.ok) {
    return { kind: 'finalized' };
  }
  return shapeFinalizeFailure(fin);
}

export async function resyncWithMainAndFinalize(
  task: Task,
  backendOrigin: string,
  opts: ResyncFinalizeOptions = {},
): Promise<ResyncOutcome> {
  const ctx = buildResyncContext(task, backendOrigin);
  if (isResyncOutcome(ctx)) return ctx;

  const mergeResult = await mergeIfNeeded(ctx, opts);
  const mergeOutcome = await handleMergeResult(ctx, mergeResult, opts);
  if (mergeOutcome) return mergeOutcome;

  return finalizeAfterCleanMerge(ctx, opts);
}
