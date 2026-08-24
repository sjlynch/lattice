import { exec, type ExecResult } from '../exec.js';
import { resetOwnedFileLocalChanges } from '../conflictResolve.js';
import {
  restoreLatticeManagedFiles,
  shelveLatticeManagedFiles,
} from '../mergeOwnedFiles.js';

export async function runWorktreeMerge(
  worktreePath: string,
  branchName: string,
  mainHeadSha: string,
  mergeMessage: string,
): Promise<ExecResult> {
  // Lattice-managed files (LATTICE_SHELVE_PATHS — LATTICE_TASK.md,
  // MERGE_INSTRUCTIONS.md, the `.claude`/`.pi`/`.codex` hook + shim files) are
  // written into each worktree and must stay untracked. If any of them got
  // committed on main — a resolver Claude's `git add .`, an agent committing
  // its own `.codex/`, a worktree older than the exclude pattern — every
  // subsequent worktree merge ABORTS with "untracked working tree files would
  // be overwritten by merge" before producing a single conflict, so no resolver
  // agent can recover it. Move Lattice's untracked copies aside for the
  // duration of the merge, then restore them.
  const shelved = await shelveLatticeManagedFiles(worktreePath);
  // Reset local changes on tracked owned files so git doesn't abort with
  // "Your local changes to <file> would be overwritten by merge". The
  // per-task Stop-hook content is regenerated post-merge by installStopHook.
  // Distinct from shelving: these are files in the index that the merge
  // wants to touch; shelving handles untracked files that the merge
  // wants to materialize.
  const resetFiles = await resetOwnedFileLocalChanges(worktreePath);
  if (resetFiles.length > 0) {
    console.log(
      `[merge] reset working-tree copy of owned file(s) before merge: ${resetFiles.join(', ')}`,
    );
  }
  // Why -m instead of --no-edit: passing a raw SHA as the merge target
  // makes git auto-generate "Merge commit '<sha>' into <branch>" — useless
  // in `git log`. Supplying our own message puts the task title in the
  // subject so `git log --oneline` is actually readable.
  try {
    return await exec(
      'git',
      ['merge', '--no-ff', '-m', mergeMessage, mainHeadSha],
      worktreePath,
    );
  } finally {
    await restoreLatticeManagedFiles(worktreePath, shelved);
  }
}
