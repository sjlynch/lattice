// Worktree merge core. Runs `git merge` *inside the worktree*, never in the
// main repo's working tree — so conflict markers never land in vite's
// watched source files. After the worktree's branch absorbs main (cleanly
// or after resolution), finalize.ts fast-forwards main to the branch tip
// (`fastForwardMain`, in merge/fastForward.ts — re-exported here).

import { isMidMerge } from './state.js';
import {
  clearMergeBlockingChanges,
  dirtyPathSet,
  readWorktreeDirtyPaths,
  restoreFailedMergeWrites,
} from './merge/mergeResidue.js';
import { mergeDiskSpaceShortfall } from './diskFull.js';
import { untrackOwnedFilesPostMerge } from './mergeOwnedFiles.js';
import { installStopHook } from './setup.js';
import {
  checkBranchState,
  emptyBranchOutcome,
} from './merge/branchState.js';
import { handleMergeConflict } from './merge/conflict.js';
import { preflightWorktreeMerge } from './merge/preflight.js';
import { runWorktreeMerge } from './merge/runWorktreeMerge.js';
import type { MergeOutcome } from './merge/types.js';

export { fastForwardMain, FF_LOCK_RETRY_DELAYS_MS } from './merge/fastForward.js';
export type { MergeConflictKind, MergeOutcome } from './merge/types.js';

// Cap on the git error text a failed (non-conflict) worktree merge returns.
const MERGE_ERROR_MESSAGE_MAX_CHARS = 500;

export async function mergeWorktreeInRepo(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
  // Required for the post-merge Stop-hook restore. We accept them as
  // params (rather than reading the task here) so this module stays
  // independent of tasks.ts and so callers that already have the task
  // object don't pay for an extra lookup.
  taskId: string,
  backendOrigin: string,
  taskTitle: string,
): Promise<MergeOutcome> {
  const preflight = await preflightWorktreeMerge(
    repoRoot,
    branchName,
    worktreePath,
    { taskId, backendOrigin },
  );
  if (!preflight.ok) return preflight.outcome;

  // A merge that runs out of disk dies part-way (diskFull.ts) — refuse up
  // front instead.
  const shortfall = await mergeDiskSpaceShortfall([repoRoot, worktreePath]);
  if (shortfall) return { status: 'error', message: shortfall };

  const branchState = await checkBranchState(repoRoot, branchName);
  switch (branchState.kind) {
    case 'already-merged':
      return { status: 'clean' };
    case 'empty':
      return emptyBranchOutcome(branchName);
    case 'error':
      return branchState.outcome;
    case 'ahead':
      break;
  }

  // ------ Merge in the worktree, not in main ------
  //
  // Why: running `git merge` in the main repo's working tree puts conflict
  // markers in source files that vite is watching. The dev server breaks,
  // even when a resolver Claude is happily working in the background.
  // Doing the merge in the worktree leaves main's files untouched. After
  // the worktree's branch absorbs main (cleanly or after resolution), we
  // fast-forward main to the branch tip — main's tree only ever changes
  // to a known-good state.
  const mergeMessage =
    `Merge main → ${taskTitle}\n\nBranch: ${branchName}`;
  // Uncommitted changes to files main changed would make git refuse the merge
  // — typically residue of an earlier attempt that died part-way (a full
  // disk). Archive them and clear just those paths first (mergeResidue.ts).
  const blocking = await clearMergeBlockingChanges(repoRoot, worktreePath, branchName, preflight.mainHeadSha);
  if (!blocking.ok) return { status: 'error', message: blocking.message };
  // What was already dirty, so a failed attempt can undo exactly what IT wrote.
  const dirtyBefore = await readWorktreeDirtyPaths(worktreePath);
  const merge = await runWorktreeMerge(
    worktreePath,
    branchName,
    preflight.mainHeadSha,
    mergeMessage,
  );

  if (merge.code === 0) {
    // If the merge brought in tracked Lattice-managed files (LATTICE_TASK.md
    // etc.) from main — from a prior accidental commit — remove them now and
    // commit the cleanup so the fix propagates when this branch FFs into main.
    await untrackOwnedFilesPostMerge(worktreePath);
    // Restore per-task Stop hook content. The pre-merge reset wiped the
    // working-tree copy back to HEAD's version (a different task's URL),
    // and the merge itself may have deleted it (if main untracked it).
    // installStopHook is idempotent, so this is also safe when the merge
    // didn't touch the file.
    await installStopHook(worktreePath, taskId, backendOrigin);
    // Worktree is clean. The caller is responsible for fastForwardMain
    // and cleanup via finalizeMergedTask — keeping the steps separate
    // means the run worker and the /merge endpoint can compose them
    // without doing the FF twice.
    return { status: 'clean' };
  }

  if (await isMidMerge(worktreePath)) {
    return handleMergeConflict(
      worktreePath,
      mergeMessage,
      undefined,
      taskId,
      backendOrigin,
    );
  }

  // Failed with no merge in progress (not a conflict): git may still have
  // written main's version of some files before dying — put them back so the
  // worktree isn't left half-merged (mergeResidue.ts).
  if (dirtyBefore) {
    await restoreFailedMergeWrites(worktreePath, dirtyPathSet(dirtyBefore)).catch((err) =>
      console.warn(`[merge] could not undo a failed merge's writes in ${worktreePath}:`, err),
    );
  }
  return {
    status: 'error',
    message: (merge.stderr.trim() || merge.stdout.trim() || 'git merge failed')
      .slice(0, MERGE_ERROR_MESSAGE_MAX_CHARS),
  };
}
