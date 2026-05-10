// Worktree merge core. Runs `git merge` *inside the worktree*, never in the
// main repo's working tree — so conflict markers never land in vite's
// watched source files. After the worktree's branch absorbs main (cleanly
// or after resolution), finalize.ts fast-forwards main to the branch tip.

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';
import { projectGit } from './projectGit.js';
import {
  isMidMerge,
  worktreeExists,
  branchCommitCount,
  branchIsAncestorOfHead,
  listConflictedFiles,
  gitDirExists,
  assertGitDirIntact,
} from './state.js';
import { assertSafeForStash } from './stash.js';
import { snapshotWorkingTree, restoreSnapshot } from './snapshot.js';
import {
  resolveOwnedFileConflicts,
  resetOwnedFileLocalChanges,
} from './conflictResolve.js';
import { LATTICE_OWNED_FILE_PATHS } from './managedFiles.js';
import { installStopHook } from './setup.js';

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
  // Pre-flight: a missing .git is the "we are about to lose user data"
  // signal. Bail before running any further git command rather than
  // letting the cascade continue (the worktree merge already passed, so
  // the worker would otherwise advance to the next task on the next loop
  // iteration with the repo in a broken state).
  if (!(await gitDirExists(repoRoot))) {
    return {
      status: 'error',
      message:
        `Cannot fast-forward: ${repoRoot}/.git is missing. The repository ` +
        `has been catastrophically corrupted; restore it (e.g. \`git init\` + ` +
        `\`git fetch origin\` + \`git reset --hard origin/main\`) before ` +
        `retrying.`,
    };
  }
  const status = await projectGit(repoRoot, ['status', '--porcelain']);
  if (status.code !== 0) {
    return {
      status: 'error',
      message: status.stderr.trim() || 'git status failed before fast-forward',
    };
  }
  // Snapshot the working tree if dirty so the FF sees a clean tree. The
  // snapshot is a directory copy under ~/.lattice/snapshots, NOT a
  // `git stash` — see snapshot.ts for why. assertSafeForStash refuses if
  // .git is missing or essentials aren't excluded.
  let snapshot;
  if (status.stdout.trim().length > 0) {
    try {
      await assertSafeForStash(repoRoot);
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }
    try {
      snapshot = await snapshotWorkingTree(repoRoot, `fastfwd-${branchName}`);
    } catch (err) {
      return {
        status: 'error',
        message:
          'Failed to snapshot before fast-forward: ' + (err as Error).message,
      };
    }
  }

  const ff = await projectGit(repoRoot, ['merge', '--ff-only', branchName]);
  if (ff.code !== 0) {
    // FF failed. Restore the snapshot so the user's mods come back, then
    // surface the FF error. We use restore (not discard) because the FF
    // didn't change anything — the working tree is back at its pre-FF
    // HEAD, and the user's mods belong on top of that exactly as before.
    if (snapshot && snapshot.dir) {
      await restoreSnapshot(snapshot, repoRoot).catch(() => undefined);
    }
    return {
      status: 'error',
      message:
        `Fast-forward of main to ${branchName} failed: ` +
        (ff.stderr.trim() || ff.stdout.trim() || 'git merge --ff-only failed'),
    };
  }

  if (snapshot && snapshot.dir) {
    // FF succeeded; HEAD has moved. Restore copies the user's snapshotted
    // versions back over whatever the FF brought in for those paths. This
    // is last-writer-wins (snapshot wins on overlap) — see snapshot.ts
    // header for the rationale. No "conflict" outcome here, unlike the
    // old stash-pop path; if the user really had overlapping changes
    // they'll see them as a dirty working tree post-restore and can
    // reconcile with `git diff`.
    await restoreSnapshot(snapshot, repoRoot).catch((err) => {
      console.warn(
        `[fastForwardMain] snapshot restore failed (continuing): ${(err as Error).message}`,
      );
    });
  }

  return { status: 'clean' };
}

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
  // ------ Pre-checks ------

  // Bail before any git command runs if the main repo's .git has gone
  // missing since the merge was queued. Otherwise git invoked in repoRoot
  // walks up the dir tree looking for a gitdir and may latch onto an
  // unrelated repo's .git, with destructive consequences.
  try {
    await assertGitDirIntact(repoRoot);
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }

  const isGit = await projectGit(repoRoot, ['rev-parse', '--show-toplevel']);
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
    await projectGit(repoRoot, ['rev-parse', 'HEAD'])
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
  // in `git log`. Supplying our own message produces "Merge branch 'main'
  // into <branch>" (the format git uses when you merge a named ref) plus
  // the task title for archaeology.
  const mergeMessage =
    `Merge branch 'main' into ${branchName}\n\nTask: ${taskTitle}`;
  let merge;
  try {
    merge = await exec(
      'git',
      ['merge', '--no-ff', '-m', mergeMessage, mainHeadSha],
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
          `${mergeMessage}\n\n[lattice-auto] auto-resolved owned files: ${resolved.join(', ')}`,
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
      await installStopHook(worktreePath, taskId, backendOrigin);
      return { status: 'clean' };
    }
    // Real conflicts remain — a resolver Claude is about to be spawned.
    // Re-install the Stop hook so its callback URL is correct for THIS
    // task before the resolver bootstraps.
    await installStopHook(worktreePath, taskId, backendOrigin);
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
