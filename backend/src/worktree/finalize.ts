// "I have a clean (post-worktree-merge) branch — bring main up to date and
// bury the worktree" step. Called from /merge after a clean
// mergeWorktreeInRepo, from /complete and /merged after a resolver Claude
// finishes, and from the merge-run worker.

import { updateTaskCrashSafe, type Task } from '../tasks.js';
import { fastForwardMain, mergeWorktreeInRepo, type MergeOutcome } from './merge.js';
import { buildStashResolveCommand } from './commands.js';
import { writeStashResolveInstructions } from './instructions.js';
import { prepareMergeConflictOutcome } from './mergeConflict.js';
import { assertGitDirIntact } from './state.js';
import { runSerializedFinalize, scheduleWorktreeCleanup } from './finalizeQueues.js';

export type FinalizeOutcome =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; stashConflict: string[]; resolveCommand: string; cwd: string }
  | {
      ok: false;
      mergeConflict: string[];
      resolveCommand: string;
      relativePath: string;
      cwd: string;
    };

type FinalizeContext = {
  task: Task;
  backendOrigin: string;
  branch: string;
  worktreePath: string;
};

type FinalizeFailure = Extract<FinalizeOutcome, { ok: false }>;
type MergeConflictFinalizeOutcome = Extract<
  FinalizeFailure,
  { mergeConflict: string[] }
>;
type FastForwardResolution = MergeOutcome | MergeConflictFinalizeOutcome;

function buildFinalizeContext(
  task: Task,
  backendOrigin: string,
): FinalizeContext | FinalizeFailure {
  if (!task.branch || !task.worktreePath) {
    return { ok: false, error: 'task missing branch/worktree info' };
  }
  // Pin these as locals so their narrowing survives into the queued closure
  // below (property narrowing on `task` would otherwise be lost there).
  return {
    task,
    backendOrigin,
    branch: task.branch,
    worktreePath: task.worktreePath,
  };
}

function isFinalizeFailure(
  value: FinalizeContext | FinalizeFailure,
): value is FinalizeFailure {
  return 'ok' in value && value.ok === false;
}

function mergeStatusSummary(result: MergeOutcome): string {
  if (result.status === 'error') return `${result.status}: ${result.message}`;
  if (result.status === 'conflict') {
    return `${result.status} (${result.conflictedFiles?.join(', ')})`;
  }
  return result.status;
}

function isMergeConflictFinalizeOutcome(
  result: FastForwardResolution,
): result is MergeConflictFinalizeOutcome {
  return 'ok' in result && result.ok === false && 'mergeConflict' in result;
}

async function preflightProjectGit(
  ctx: FinalizeContext,
): Promise<FinalizeFailure | null> {
  // Bail before any git work if .git went missing — same rationale as in
  // mergeWorktreeInRepo. Without this, an FF on a deleted repo can
  // accidentally operate on a *different* repo's gitdir found by walking
  // up the directory tree.
  try {
    await assertGitDirIntact(ctx.task.projectPath);
    return null;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function fastForwardBranch(ctx: FinalizeContext): Promise<MergeOutcome> {
  // FF main if it's behind. fastForwardMain is a no-op when main is
  // already at the branch tip (git just says "Already up to date") and
  // still handles the copy-snapshot + restore of a dirty tree correctly.
  console.log(`[finalize] fast-forwarding main to ${ctx.branch}...`);
  const ff = await fastForwardMain(ctx.task.projectPath, ctx.branch);
  console.log(`[finalize] fastForwardMain → ${mergeStatusSummary(ff)}`);
  return ff;
}

async function retryFastForwardAfterResyncFailure(
  ctx: FinalizeContext,
  originalFailure: Extract<MergeOutcome, { status: 'error' }>,
): Promise<FastForwardResolution> {
  // If FF failed and we have a worktree, a concurrent finalize may have
  // advanced main past where this branch was last synced (two resolver
  // Claudes finishing at the same time both re-sync to the same main HEAD,
  // then one finalize runs first and advances main, leaving the second
  // branch stale). Re-sync inside the queue so we see the latest HEAD and
  // retry the fast-forward exactly once.
  console.log(
    `[finalize] ${ctx.task.id}: FF failed — re-syncing with current main and retrying`,
  );
  const reSync = await mergeWorktreeInRepo(
    ctx.task.projectPath,
    ctx.branch,
    ctx.worktreePath,
    ctx.task.id,
    ctx.backendOrigin,
    ctx.task.title,
  );
  if (reSync.status === 'clean') {
    const retry = await fastForwardMain(ctx.task.projectPath, ctx.branch);
    console.log(
      `[finalize] retry FF → ${retry.status}${retry.status === 'error' ? `: ${retry.message}` : ''}`,
    );
    return retry;
  }
  if (reSync.status === 'conflict') {
    console.log(
      `[finalize] ${ctx.task.id}: re-sync conflict — ${reSync.conflictedFiles.join(', ')}`,
    );
    return writeMergeConflictFinalizeOutcome(ctx, reSync.conflictedFiles);
  }
  console.log(`[finalize] ${ctx.task.id}: re-sync error: ${reSync.message}`);
  // Preserve the historical outcome: a re-sync error after the first FF error
  // falls through as the original FF failure.
  return originalFailure;
}

async function fastForwardWithOneResyncRetry(
  ctx: FinalizeContext,
): Promise<FastForwardResolution> {
  const ff = await fastForwardBranch(ctx);
  if (ff.status !== 'error') return ff;
  return retryFastForwardAfterResyncFailure(ctx, ff);
}

async function writeMergeConflictFinalizeOutcome(
  ctx: FinalizeContext,
  conflictedFiles: string[],
): Promise<MergeConflictFinalizeOutcome> {
  // mergeWorktreeInRepo/handleMergeConflict has already left the worktree
  // mid-merge (MERGE_HEAD + conflict markers) and reinstalled the Stop hook.
  // Handle this exactly like a first-pass conflict (mirror
  // resyncFinalize's conflict branch): write the resolver instructions, flag
  // the task so the UI/run can re-spawn a resolver, and return a resolvable
  // outcome instead of a bare error — otherwise the task is stranded at
  // ready_to_merge with a leftover mid-merge worktree and no second resolver.
  const { relativePath, command } = await prepareMergeConflictOutcome({
    task: ctx.task,
    branch: ctx.branch,
    conflictedFiles,
    backendOrigin: ctx.backendOrigin,
    worktreePath: ctx.worktreePath,
  });
  return {
    ok: false,
    mergeConflict: conflictedFiles,
    resolveCommand: command,
    relativePath,
    cwd: ctx.worktreePath,
  };
}

async function writeStashConflictFinalizeOutcome(
  ctx: FinalizeContext,
  conflict: Extract<MergeOutcome, { status: 'conflict' }>,
): Promise<FinalizeFailure> {
  const { relativePath } = await writeStashResolveInstructions(
    ctx.task,
    conflict.conflictedFiles,
    conflict.stashRef ?? '',
    ctx.backendOrigin,
    ctx.task.projectPath,
  );
  return {
    ok: false,
    stashConflict: conflict.conflictedFiles,
    resolveCommand: buildStashResolveCommand(relativePath),
    cwd: ctx.task.projectPath,
  };
}

// Resolves false when the qa state was NOT recorded — the disk write failed
// (updateTaskCrashSafe leaves cache + disk untouched and returns null) or the
// task no longer exists.
async function transitionTaskToQaOnDisk(ctx: FinalizeContext): Promise<boolean> {
  // Write QA status to disk BEFORE cleanup. This is the critical ordering:
  // if the server crashes after this write, the task is already QA on disk
  // and will be recovered correctly on restart. A crash between FF and here
  // still leaves the task at ready_to_merge (recoverable via startup check).
  console.log(`[finalize] writing qa state for task ${ctx.task.id} to disk...`);
  const updated = await updateTaskCrashSafe(ctx.task.id, {
    status: 'qa',
    mergedAt: Date.now(),
    worktreePath: undefined,
    branch: undefined,
    conflict: undefined,
    conflictStartedAt: undefined,
  });
  if (!updated) return false;
  console.log(`[finalize] task ${ctx.task.id} → qa ✓`);
  return true;
}

function scheduleBackgroundCleanup(ctx: FinalizeContext): void {
  // Cleanup runs in the background. The task is already qa-on-disk so the
  // user-visible state is correct; a stuck cleanup must not block this
  // function (it's awaited by the merge-run worker, which would otherwise
  // hang mid-iteration with processed/merged stuck below total — exactly
  // the "100% Task N of N · k merged" stale-progress symptom).
  scheduleWorktreeCleanup(
    ctx.task.projectPath,
    ctx.worktreePath,
    ctx.branch,
    ctx.task.id,
  );
}

async function handleFastForwardSuccess(
  ctx: FinalizeContext,
): Promise<FinalizeOutcome> {
  if (!(await transitionTaskToQaOnDisk(ctx))) {
    // main already fast-forwarded, but the task is still ready_to_merge.
    // Cleaning up now would delete the worktree + branch the task still
    // points at, so a retry could never re-finalize it (and the run would
    // count it merged while the board shows it waiting). Keep both: a retry
    // FF is a no-op "already up to date" and records qa then.
    console.error(`[finalize] task ${ctx.task.id}: could not record qa state — keeping worktree for a retry`);
    return {
      ok: false,
      error: 'Branch fast-forwarded, but the task\'s qa state could not be saved; retry the merge to finish it.',
    };
  }
  scheduleBackgroundCleanup(ctx);
  return { ok: true };
}

async function resolveFinalizeOutcome(
  ctx: FinalizeContext,
): Promise<FinalizeOutcome> {
  const preflightError = await preflightProjectGit(ctx);
  if (preflightError) return preflightError;

  const ff = await fastForwardWithOneResyncRetry(ctx);
  if (isMergeConflictFinalizeOutcome(ff)) return ff;
  if (ff.status === 'error') {
    return { ok: false, error: ff.message };
  }
  if (ff.status === 'conflict') {
    return writeStashConflictFinalizeOutcome(ctx, ff);
  }
  if (ff.snapshotWarning) {
    // HEAD moved successfully; avoid the FF retry path, but keep the task and
    // worktree available and surface the retained snapshot in the route/run.
    return { ok: false, error: `Branch fast-forwarded, but ${ff.snapshotWarning}` };
  }
  return handleFastForwardSuccess(ctx);
}

export async function finalizeMergedTask(
  task: Task,
  backendOrigin: string,
): Promise<FinalizeOutcome> {
  const ctx = buildFinalizeContext(task, backendOrigin);
  if (isFinalizeFailure(ctx)) return ctx;

  // Serialize per project: fastForwardMain moves main's HEAD and must not run
  // concurrently with another finalize for the same project (see finalizeQueues).
  return runSerializedFinalize(task.projectPath, async () => {
    console.log(`[finalize] ${task.id} — branch=${ctx.branch}`);
    return resolveFinalizeOutcome(ctx);
  });
}
