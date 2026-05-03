// "I have a clean (post-worktree-merge) branch — bring main up to date and
// bury the worktree" step. Called from /merge after a clean
// mergeWorktreeInRepo, from /complete and /merged after a resolver Claude
// finishes, and from the merge-run worker.

import { updateTaskCrashSafe, type Task } from '../tasks.js';
import { fastForwardMain } from './merge.js';
import { buildStashResolveCommand } from './commands.js';
import { writeStashResolveInstructions } from './instructions.js';
import { cleanupWorktreeForTask } from './cleanup.js';

export type FinalizeOutcome =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; stashConflict: string[]; resolveCommand: string; cwd: string };

// Per-project promise queue. fastForwardMain modifies main's HEAD and
// must not run concurrently with another finalize for the same project —
// the second caller's branch would have been merged against a stale HEAD
// and would no longer be a fast-forward ancestor of main.
const finalizeQueues = new Map<string, Promise<void>>();

// Per-project queue for background worktree cleanup. Cleanup runs sequentially
// per project (so two `git worktree remove` calls don't race on .git/index.lock)
// but is decoupled from finalize itself: a hung cleanup on Windows (where a
// process holding the worktree dir open could deadlock `git worktree remove`)
// must not stall the run worker, since the task is already qa-on-disk.
const cleanupQueues = new Map<string, Promise<void>>();

function scheduleWorktreeCleanup(
  projectPath: string,
  worktreePath: string,
  branchName: string,
  taskId: string,
): void {
  const prev = cleanupQueues.get(projectPath) ?? Promise.resolve();
  const next = prev.then(async () => {
    console.log(`[finalize] cleaning up worktree ${worktreePath}...`);
    try {
      await cleanupWorktreeForTask(projectPath, worktreePath, branchName);
      console.log(`[finalize] worktree cleanup done for ${taskId}`);
    } catch (err) {
      console.error(
        `[finalize] background cleanup failed for ${taskId} (task already qa, leaves orphaned worktree dir):`,
        err,
      );
    }
  });
  cleanupQueues.set(projectPath, next);
  // Detach so an unhandled rejection in this chain never crashes the process —
  // the .then handler above already swallows errors but belt-and-braces.
  next.catch(() => {});
}

export async function finalizeMergedTask(task: Task, backendOrigin: string): Promise<FinalizeOutcome> {
  if (!task.branch || !task.worktreePath) {
    return { ok: false, error: 'task missing branch/worktree info' };
  }

  const prev = finalizeQueues.get(task.projectPath) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((r) => { release = r; });
  finalizeQueues.set(task.projectPath, slot);
  // Swallow errors from previous finalizes so one failure doesn't jam the queue.
  await prev.catch(() => {});

  console.log(`[finalize] ${task.id} — branch=${task.branch}`);
  try {
    // FF main if it's behind. fastForwardMain is a no-op when main is
    // already at the branch tip (git just says "Already up to date") and
    // still handles the auto-stash + pop dance correctly.
    console.log(`[finalize] fast-forwarding main to ${task.branch}...`);
    const ff = await fastForwardMain(task.projectPath, task.branch);
    console.log(`[finalize] fastForwardMain → ${ff.status}${ff.status === 'error' ? `: ${ff.message}` : ff.status === 'conflict' ? ` (${ff.conflictedFiles?.join(', ')})` : ''}`);
    if (ff.status === 'error') {
      return { ok: false, error: ff.message };
    }
    if (ff.status === 'conflict') {
      const { relativePath } = await writeStashResolveInstructions(
        task,
        ff.conflictedFiles,
        ff.stashRef ?? '',
        backendOrigin,
        task.projectPath,
      );
      return {
        ok: false,
        stashConflict: ff.conflictedFiles,
        resolveCommand: buildStashResolveCommand(relativePath),
        cwd: task.projectPath,
      };
    }
    // Write QA status to disk BEFORE cleanup. This is the critical ordering:
    // if the server crashes after this write, the task is already QA on disk
    // and will be recovered correctly on restart. A crash between FF and here
    // still leaves the task at ready_to_merge (recoverable via startup check).
    console.log(`[finalize] writing qa state for task ${task.id} to disk...`);
    await updateTaskCrashSafe(task.id, {
      status: 'qa',
      mergedAt: Date.now(),
      worktreePath: undefined,
      branch: undefined,
      conflict: undefined,
      conflictStartedAt: undefined,
    });
    console.log(`[finalize] task ${task.id} → qa ✓`);
    // Cleanup runs in the background. The task is already qa-on-disk so the
    // user-visible state is correct; a stuck cleanup must not block this
    // function (it's awaited by the merge-run worker, which would otherwise
    // hang mid-iteration with processed/merged stuck below total — exactly
    // the "100% Task N of N · k merged" stale-progress symptom).
    scheduleWorktreeCleanup(
      task.projectPath,
      task.worktreePath,
      task.branch,
      task.id,
    );
    return { ok: true };
  } finally {
    release();
  }
}
