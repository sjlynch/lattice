// "I have a clean (post-worktree-merge) branch — bring main up to date and
// bury the worktree" step. Called from /merge after a clean
// mergeWorktreeInRepo, from /complete and /merged after a resolver Claude
// finishes, and from the merge-run worker.

import { updateTaskCrashSafe, type Task } from '../tasks.js';
import { fastForwardMain, mergeWorktreeInRepo } from './merge.js';
import { buildStashResolveCommand } from './commands.js';
import { writeStashResolveInstructions } from './instructions.js';
import { assertGitDirIntact } from './state.js';
import { runSerializedFinalize, scheduleWorktreeCleanup } from './finalizeQueues.js';

export type FinalizeOutcome =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; stashConflict: string[]; resolveCommand: string; cwd: string };

export async function finalizeMergedTask(task: Task, backendOrigin: string): Promise<FinalizeOutcome> {
  if (!task.branch || !task.worktreePath) {
    return { ok: false, error: 'task missing branch/worktree info' };
  }
  // Pin these as locals so their narrowing survives into the queued closure
  // below (property narrowing on `task` would otherwise be lost there).
  const branch = task.branch;
  const worktreePath = task.worktreePath;

  // Serialize per project: fastForwardMain moves main's HEAD and must not run
  // concurrently with another finalize for the same project (see finalizeQueues).
  return runSerializedFinalize(task.projectPath, async () => {
    console.log(`[finalize] ${task.id} — branch=${branch}`);
    // Bail before any git work if .git went missing — same rationale as in
    // mergeWorktreeInRepo. Without this, an FF on a deleted repo can
    // accidentally operate on a *different* repo's gitdir found by walking
    // up the directory tree.
    try {
      await assertGitDirIntact(task.projectPath);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    // FF main if it's behind. fastForwardMain is a no-op when main is
    // already at the branch tip (git just says "Already up to date") and
    // still handles the auto-stash + pop dance correctly.
    console.log(`[finalize] fast-forwarding main to ${branch}...`);
    let ff = await fastForwardMain(task.projectPath, branch);
    console.log(`[finalize] fastForwardMain → ${ff.status}${ff.status === 'error' ? `: ${ff.message}` : ff.status === 'conflict' ? ` (${ff.conflictedFiles?.join(', ')})` : ''}`);
    // If FF failed and we have a worktree, a concurrent finalize may have
    // advanced main past where this branch was last synced (two resolver
    // Claudes finishing at the same time both re-sync to the same main HEAD,
    // then one finalize runs first and advances main, leaving the second
    // branch stale). Re-sync inside the queue so we see the latest HEAD and
    // retry the fast-forward exactly once.
    if (ff.status === 'error') {
      console.log(`[finalize] ${task.id}: FF failed — re-syncing with current main and retrying`);
      const reSync = await mergeWorktreeInRepo(task.projectPath, branch, worktreePath, task.id, backendOrigin, task.title);
      if (reSync.status === 'clean') {
        ff = await fastForwardMain(task.projectPath, branch);
        console.log(`[finalize] retry FF → ${ff.status}${ff.status === 'error' ? `: ${ff.message}` : ''}`);
      } else if (reSync.status === 'conflict') {
        console.log(`[finalize] ${task.id}: re-sync conflict — ${reSync.conflictedFiles.join(', ')}`);
        return {
          ok: false,
          error: `Re-sync with main introduced new conflicts: ${reSync.conflictedFiles.join(', ')}`,
        };
      } else {
        console.log(`[finalize] ${task.id}: re-sync error: ${reSync.message}`);
        // fall through — original ff error is returned below
      }
    }
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
      worktreePath,
      branch,
      task.id,
    );
    return { ok: true };
  });
}
