// Worktree merge core. Runs `git merge` *inside the worktree*, never in the
// main repo's working tree — so conflict markers never land in vite's
// watched source files. After the worktree's branch absorbs main (cleanly
// or after resolution), finalize.ts fast-forwards main to the branch tip.

import { projectGit } from './projectGit.js';
import { isMidMerge, gitDirExists } from './state.js';
import { assertSafeForStash } from './stash.js';
import {
  snapshotWorkingTree,
  restoreSnapshot,
  type SnapshotHandle,
} from './snapshot.js';
import { untrackOwnedFilesPostMerge } from './mergeOwnedFiles.js';
import { installStopHook } from './setup.js';
import {
  checkBranchState,
  emptyBranchOutcome,
} from './merge/branchState.js';
import { handleMergeConflict } from './merge/conflict.js';
import { assertMainOnBranch, preflightWorktreeMerge } from './merge/preflight.js';
import { runWorktreeMerge } from './merge/runWorktreeMerge.js';
import { clearStaleGitLocks, gitLockPathFromError } from './staleGitLocks.js';

// Back-off before re-trying a fast-forward that collided with another git
// process's lock (an IDE's background `git status`, the user's own command).
export const FF_LOCK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export type MergeConflictKind = 'merge' | 'stash-pop';

export type MergeOutcome =
  | { status: 'clean'; snapshotWarning?: string }
  | {
      status: 'conflict';
      conflictKind: MergeConflictKind;
      conflictedFiles: string[];
      stashRef?: string;
    }
  | { status: 'error'; message: string };

// Fast-forward main (in `repoRoot`) to the tip of `branchName`. A dirty
// working tree is captured into a copy-based snapshot (snapshot.ts — never
// `git stash`) before the FF and restored afterwards. Used after the
// in-worktree merge succeeds so the resolved branch tip becomes main's new
// tip without ever putting conflict markers in main's working files.
//
// Reads as three linear phases (see the private helpers below): preflight +
// snapshot, perform the FF, restore the snapshot. None of the git commands,
// their ordering, or the snapshot behavior changed in the extraction.
export async function fastForwardMain(
  repoRoot: string,
  branchName: string,
): Promise<MergeOutcome> {
  const prepared = await prepareFastForward(repoRoot, branchName);
  if (!prepared.ok) return prepared.outcome;

  const ff = await performFastForward(repoRoot, branchName, prepared.snapshot);
  if (!ff.ok) return ff.outcome;

  const snapshotWarning = await restoreAfterFastForward(repoRoot, prepared.snapshot);
  return { status: 'clean', ...(snapshotWarning ? { snapshotWarning } : {}) };
}

type FastForwardPreparation =
  | { ok: true; snapshot: SnapshotHandle | undefined }
  | { ok: false; outcome: MergeOutcome };

// Phase 1 — preflight + snapshot. Assert `.git` is present, confirm
// `git status` succeeds, and (only when the working tree is dirty) copy it
// into a snapshot so the FF sees a clean tree. Returns the snapshot handle
// (undefined when the tree was already clean); any git/snapshot failure is
// surfaced as an error outcome for the orchestrator to return verbatim.
async function prepareFastForward(
  repoRoot: string,
  branchName: string,
): Promise<FastForwardPreparation> {
  // Pre-flight: a missing .git is the "we are about to lose user data"
  // signal. Bail before running any further git command rather than
  // letting the cascade continue (the worktree merge already passed, so
  // the worker would otherwise advance to the next task on the next loop
  // iteration with the repo in a broken state).
  if (!(await gitDirExists(repoRoot))) {
    return {
      ok: false,
      outcome: {
        status: 'error',
        message:
          `Cannot fast-forward: ${repoRoot}/.git is missing. The repository ` +
          `has been catastrophically corrupted; restore it (e.g. \`git init\` + ` +
          `\`git fetch origin\` + \`git reset --hard origin/main\`) before ` +
          `retrying.`,
      },
    };
  }
  // `merge --ff-only` merges into whatever HEAD is. On a detached HEAD the
  // branch tip would land nowhere `main` can see, and cleanup then deletes
  // the branch — so refuse here too, not only in the worktree-merge
  // preflight (a resolver's /complete can reach the FF without it).
  const onBranch = await assertMainOnBranch(repoRoot);
  if (!onBranch.ok) return onBranch;
  // A lock file a killed git left behind fails the snapshot's resets and the
  // FF itself; clear it first when it is provably abandoned (staleGitLocks.ts).
  await clearStaleGitLocks(repoRoot);
  const status = await projectGit(repoRoot, ['status', '--porcelain']);
  if (status.code !== 0) {
    return {
      ok: false,
      outcome: {
        status: 'error',
        message:
          status.stderr.trim() || 'git status failed before fast-forward',
      },
    };
  }
  // Snapshot the working tree if dirty so the FF sees a clean tree. The
  // snapshot is a directory copy under ~/.lattice/snapshots, NOT a
  // `git stash` — see snapshot.ts for why. assertSafeForStash refuses if
  // .git is missing or essentials aren't excluded.
  if (status.stdout.trim().length === 0) {
    return { ok: true, snapshot: undefined };
  }
  try {
    await assertSafeForStash(repoRoot);
  } catch (err) {
    return {
      ok: false,
      outcome: { status: 'error', message: (err as Error).message },
    };
  }
  try {
    // Only the paths this fast-forward rewrites can be clobbered by it (git
    // refuses, writing nothing, when an unlisted dirty path would be), so only
    // those need protecting. A diff failure falls back to the full snapshot.
    const changed = await projectGit(repoRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', branchName]);
    const onlyPaths = changed.code === 0 ? changed.stdout.split('\0').filter(Boolean) : undefined;
    const snapshot = await snapshotWorkingTree(
      repoRoot,
      `fastfwd-${branchName}`,
      onlyPaths ? { onlyPaths } : {},
    );
    return { ok: true, snapshot: snapshot.dir ? snapshot : undefined };
  } catch (err) {
    return {
      ok: false,
      outcome: {
        status: 'error',
        message:
          'Failed to snapshot before fast-forward: ' + (err as Error).message,
      },
    };
  }
}

// Phase 2 — the fast-forward itself: `git merge --ff-only`. On failure the
// snapshot is restored (the FF changed nothing, so the tree is back at its
// pre-FF HEAD and the user's mods belong on top of that exactly as before)
// and the FF error is surfaced.
async function performFastForward(
  repoRoot: string,
  branchName: string,
  snapshot: SnapshotHandle | undefined,
): Promise<{ ok: true } | { ok: false; outcome: MergeOutcome }> {
  let ff = await projectGit(repoRoot, ['merge', '--ff-only', branchName]);
  // A lock collision is transient (another git process mid-command) or an
  // abandoned lock that ages past the stale threshold — retry a few times,
  // clearing a now-provably-stale lock in between, before giving up.
  for (const delay of FF_LOCK_RETRY_DELAYS_MS) {
    if (ff.code === 0 || !gitLockPathFromError(ff.stderr + ff.stdout)) break;
    console.warn(`[fastForwardMain] ${branchName}: git lock busy — retrying in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    await clearStaleGitLocks(repoRoot);
    ff = await projectGit(repoRoot, ['merge', '--ff-only', branchName]);
  }
  if (ff.code !== 0) {
    // FF failed. Restore the snapshot so the user's mods come back, then
    // surface the FF error. We use restore (not discard) because the FF
    // didn't change anything — the working tree is back at its pre-FF
    // HEAD, and the user's mods belong on top of that exactly as before.
    // A partial/failed restore used to be swallowed, leaving the user's edits
    // in a retained snapshot nobody was told about — append it to the error.
    const restoreWarning = await restoreAfterFastForward(repoRoot, snapshot);
    return {
      ok: false,
      outcome: {
        status: 'error',
        message:
          `Fast-forward of main to ${branchName} failed: ` +
          (ff.stderr.trim() ||
            ff.stdout.trim() ||
            'git merge --ff-only failed') +
          (restoreWarning ? ` (${restoreWarning})` : ''),
      },
    };
  }
  return { ok: true };
}

// Phase 3 — restore after a successful FF. Newer dirty edits survive; captured
// versions overlay only verified clean HEAD content. A partial restore returns
// a warning that finalize surfaces without retrying the already-landed FF.
async function restoreAfterFastForward(
  repoRoot: string,
  snapshot: SnapshotHandle | undefined,
): Promise<string | undefined> {
  if (snapshot && snapshot.dir) {
    try {
      const restored = await restoreSnapshot(snapshot, repoRoot);
      if (restored.status === 'restored') return;
      const warning = `Snapshot partly restored; newer edits preserved, captured versions retained at ${snapshot.dir}`;
      console.warn(`[fastForwardMain] ${warning}`);
      return warning;
    } catch (err) {
      const warning = `Snapshot restore failed; captured versions retained at ${snapshot.dir}: ${(err as Error).message}`;
      console.warn(`[fastForwardMain] ${warning}`);
      return warning;
    }
  }
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
  const preflight = await preflightWorktreeMerge(
    repoRoot,
    branchName,
    worktreePath,
    { taskId, backendOrigin },
  );
  if (!preflight.ok) return preflight.outcome;

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

  return {
    status: 'error',
    message: (merge.stderr.trim() || merge.stdout.trim() || 'git merge failed')
      .slice(0, 500),
  };
}
