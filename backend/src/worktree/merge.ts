// Worktree merge core. Runs `git merge` *inside the worktree*, never in the
// main repo's working tree — so conflict markers never land in vite's
// watched source files. After the worktree's branch absorbs main (cleanly
// or after resolution), finalize.ts fast-forwards main to the branch tip.

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';
import {
  isMidMerge,
  worktreeExists,
  branchCommitCount,
  branchIsAncestorOfHead,
  listConflictedFiles,
} from './state.js';
import { autoStashMessage, popStashByMessage } from './stash.js';
import { resolveOwnedFileConflicts } from './conflictResolve.js';
import { LATTICE_OWNED_FILE_PATHS } from './managedFiles.js';

// Files that Lattice writes into every worktree root but must never be
// committed. If a previous resolver Claude accidentally ran `git add .`
// and committed one of these, future merges into other worktrees fail with
// "untracked working tree files would be overwritten by merge." Moving
// them aside before `git merge` and restoring afterwards sidesteps this.
//
// `.claude/settings.local.json` is intentionally NOT shelved here even
// though Lattice owns it — it would conflict on merge if tracked, and
// auto-resolving the conflict (see resolveOwnedFileConflicts below) is
// cleaner than shelving + restoring (which would just cover up the
// tracked-file problem instead of fixing it).
const LATTICE_MANAGED_FILES = ['LATTICE_TASK.md', 'MERGE_INSTRUCTIONS.md'];

async function shelveLatticeManagedFiles(worktreePath: string): Promise<string[]> {
  const shelved: string[] = [];
  for (const f of LATTICE_MANAGED_FILES) {
    const src = path.join(worktreePath, f);
    try {
      await fs.access(src);
      await fs.rename(src, `${src}.lattice-bak`);
      shelved.push(f);
    } catch { /* file absent — nothing to move */ }
  }
  return shelved;
}

async function restoreLatticeManagedFiles(worktreePath: string, files: string[]): Promise<void> {
  for (const f of files) {
    try {
      await fs.rename(`${path.join(worktreePath, f)}.lattice-bak`, path.join(worktreePath, f));
    } catch { /* ignore */ }
  }
}

// After a clean merge, the merge commit may have brought in any owned
// file (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md, .claude/settings.local.json)
// as a tracked file because main had it accidentally committed. Remove
// each from the index and commit the cleanup so the removal propagates
// when this branch is fast-forwarded into main.
//
// Iterates the central owned-file list rather than the shelved subset:
// `.claude/settings.local.json` isn't shelved (Layer 2 auto-resolves its
// conflicts instead) but should still be untracked here if main carried
// it through the merge.
async function untrackOwnedFilesPostMerge(worktreePath: string): Promise<void> {
  const toRemove: string[] = [];
  for (const f of LATTICE_OWNED_FILE_PATHS) {
    const check = await exec('git', ['ls-files', f], worktreePath);
    if (check.stdout.trim()) toRemove.push(f);
  }
  if (toRemove.length === 0) return;
  await exec('git', ['rm', '--cached', ...toRemove], worktreePath);
  await exec(
    'git',
    [
      'commit',
      '-m',
      `Untrack Lattice-managed files [lattice-auto]\n\n${toRemove.map((f) => `- ${f}`).join('\n')}`,
    ],
    worktreePath,
  );
  console.log(`[merge] untracked accidentally committed lattice file(s): ${toRemove.join(', ')}`);
}


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

  // Lattice-managed files (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md) are
  // written into each worktree root and must stay untracked. If a prior
  // resolver Claude accidentally committed one via `git add .`, every
  // subsequent worktree merge fails with "untracked file would be
  // overwritten". Move them aside for the duration of the merge so git
  // doesn't see them, then restore whatever state they were in.
  const shelved = await shelveLatticeManagedFiles(worktreePath);
  let merge;
  try {
    merge = await exec(
      'git',
      ['merge', '--no-ff', '--no-edit', mainHeadSha],
      worktreePath,
    );
  } finally {
    await restoreLatticeManagedFiles(worktreePath, shelved);
  }

  if (merge.code === 0) {
    // If the merge brought in tracked Lattice-managed files (LATTICE_TASK.md
    // etc.) from main — from a prior accidental commit — remove them now and
    // commit the cleanup so the fix propagates when this branch FFs into main.
    await untrackOwnedFilesPostMerge(worktreePath);
    // Worktree is clean. The caller is responsible for fastForwardMain
    // and cleanup via finalizeMergedTask — keeping the steps separate
    // means the run worker and the /merge endpoint can compose them
    // without doing the FF twice.
    return { status: 'clean' };
  }

  if (await isMidMerge(worktreePath)) {
    // Auto-resolve any Lattice-owned files in the conflict set. If they
    // were the only conflicts, complete the merge ourselves and report
    // `clean` so the caller can finalize without spawning a resolver
    // Claude (which would have been bootstrapped against a malformed
    // .claude/settings.local.json full of conflict markers).
    const { resolved, remaining } = await resolveOwnedFileConflicts(
      worktreePath,
      'merge',
    );
    if (resolved.length > 0) {
      console.log(
        `[merge] auto-resolved ${resolved.length} owned file(s) in ${worktreePath}: ${resolved.join(', ')}`,
      );
    }
    if (remaining.length === 0) {
      const commit = await exec(
        'git',
        [
          'commit',
          '--no-edit',
          '-m',
          'Merge with auto-resolved Lattice-owned files [lattice-auto]',
        ],
        worktreePath,
      );
      if (commit.code !== 0) {
        return {
          status: 'error',
          message: `Auto-resolve commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`.slice(0, 500),
        };
      }
      // Same post-clean cleanup as the all-clean path: drop any tracked
      // managed files (LATTICE_TASK.md etc.) the merge brought in.
      await untrackOwnedFilesPostMerge(worktreePath);
      return { status: 'clean' };
    }
    return {
      status: 'conflict',
      conflictKind: 'merge',
      conflictedFiles: remaining,
    };
  }

  return {
    status: 'error',
    message: (merge.stderr.trim() || merge.stdout.trim() || 'git merge failed')
      .slice(0, 500),
  };
}
