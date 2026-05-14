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
  // Lattice-managed files (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md) are
  // written into each worktree root and must stay untracked. If a prior
  // resolver Claude accidentally committed one via `git add .`, every
  // subsequent worktree merge fails with "untracked file would be
  // overwritten". Move them aside for the duration of the merge so git
  // doesn't see them, then restore whatever state they were in.
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
