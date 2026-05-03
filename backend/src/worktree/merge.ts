// Worktree merge core. Runs `git merge` *inside the worktree*, never in the
// main repo's working tree — so conflict markers never land in vite's
// watched source files. After the worktree's branch absorbs main (cleanly
// or after resolution), finalize.ts fast-forwards main to the branch tip.

import { exec } from './exec.js';
import {
  isMidMerge,
  worktreeExists,
  branchCommitCount,
  branchIsAncestorOfHead,
  listConflictedFiles,
} from './state.js';
import { autoStashMessage, popStashByMessage } from './stash.js';

export type MergeConflictKind = 'merge' | 'stash-pop';

export type MergeOutcome =
  | { status: 'clean' }
  | {
      status: 'conflict';
      conflictKind: MergeConflictKind;
      conflictedFiles: string[];
      stashRef?: string;
    }
  | { status: 'error'; message: string };

// Fast-forward main (in `repoRoot`) to the tip of `branchName`. Auto-
// stashes a dirty working tree before the FF and pops it afterwards.
// Used after the in-worktree merge succeeds so the resolved branch tip
// becomes main's new tip without ever putting conflict markers in main's
// working files.
export async function fastForwardMain(
  repoRoot: string,
  branchName: string,
): Promise<MergeOutcome> {
  const status = await exec('git', ['status', '--porcelain'], repoRoot);
  if (status.code !== 0) {
    return {
      status: 'error',
      message: status.stderr.trim() || 'git status failed before fast-forward',
    };
  }
  const stashLabel = autoStashMessage(branchName);
  let stashRef: string | undefined;
  if (status.stdout.trim().length > 0) {
    const stash = await exec(
      'git',
      ['stash', 'push', '--include-untracked', '-m', stashLabel],
      repoRoot,
    );
    if (stash.code !== 0) {
      return {
        status: 'error',
        message:
          'Failed to auto-stash before fast-forward: ' +
          (stash.stderr.trim() || stash.stdout.trim() || 'git stash failed'),
      };
    }
    stashRef = stashLabel;
  }

  const ff = await exec(
    'git',
    ['merge', '--ff-only', branchName],
    repoRoot,
  );
  if (ff.code !== 0) {
    if (stashRef) {
      await popStashByMessage(repoRoot, stashRef).catch(() => undefined);
    }
    return {
      status: 'error',
      message:
        `Fast-forward of main to ${branchName} failed: ` +
        (ff.stderr.trim() || ff.stdout.trim() || 'git merge --ff-only failed'),
    };
  }

  if (stashRef) {
    const popped = await popStashByMessage(repoRoot, stashRef);
    if (popped.kind === 'conflict') {
      return {
        status: 'conflict',
        conflictKind: 'stash-pop',
        conflictedFiles: popped.conflictedFiles,
        stashRef,
      };
    }
    if (popped.kind === 'error') {
      return { status: 'error', message: popped.message };
    }
  }

  return { status: 'clean' };
}

export async function mergeWorktreeInRepo(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
): Promise<MergeOutcome> {
  // ------ Pre-checks ------

  const isGit = await exec('git', ['rev-parse', '--show-toplevel'], repoRoot);
  if (isGit.code !== 0) {
    return { status: 'error', message: `Not a git repository: ${repoRoot}` };
  }

  if (await isMidMerge(repoRoot)) {
    return {
      status: 'error',
      message:
        'Main repo is already in a merge state (MERGE_HEAD exists). ' +
        'Resolve or `git merge --abort` first.',
    };
  }

  if (!(await worktreeExists(worktreePath))) {
    return {
      status: 'error',
      message: `Worktree directory not found at ${worktreePath}.`,
    };
  }

  if (await isMidMerge(worktreePath)) {
    return {
      status: 'error',
      message:
        `Worktree at ${worktreePath} is already in a merge state — a ` +
        `previous resolver may still be running. Inspect, or run ` +
        `\`git -C "${worktreePath}" merge --abort\` to retry from scratch.`,
    };
  }

  // ------ Branch state checks ------

  const commits = await branchCommitCount(repoRoot, branchName);
  if (commits === 0) {
    const isAncestor = await branchIsAncestorOfHead(repoRoot, branchName);
    if (isAncestor) {
      // All branch commits are already in main — it was previously merged
      // (including the case where main was fast-forwarded exactly to the
      // branch tip, making `behind` = 0). Caller should run cleanup.
      return { status: 'clean' };
    }
    return {
      status: 'error',
      message:
        `Branch "${branchName}" was not found or is not reachable from HEAD ` +
        `and has no commits ahead. Inspect with \`git branch -a\` and ` +
        `\`git log ${branchName}\`.`,
    };
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

  const mainHeadSha = (
    await exec('git', ['rev-parse', 'HEAD'], repoRoot)
  ).stdout.trim();
  if (!mainHeadSha) {
    return { status: 'error', message: 'Could not read main HEAD SHA.' };
  }

  const merge = await exec(
    'git',
    ['merge', '--no-ff', '--no-edit', mainHeadSha],
    worktreePath,
  );

  if (merge.code === 0) {
    // Worktree is clean. The caller is responsible for fastForwardMain
    // and cleanup via finalizeMergedTask — keeping the steps separate
    // means the run worker and the /merge endpoint can compose them
    // without doing the FF twice.
    return { status: 'clean' };
  }

  if (await isMidMerge(worktreePath)) {
    const conflictedFiles = await listConflictedFiles(worktreePath);
    return {
      status: 'conflict',
      conflictKind: 'merge',
      conflictedFiles,
    };
  }

  return {
    status: 'error',
    message: (merge.stderr.trim() || merge.stdout.trim() || 'git merge failed')
      .slice(0, 500),
  };
}
