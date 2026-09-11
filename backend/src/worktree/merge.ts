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
import { preflightWorktreeMerge } from './merge/preflight.js';
import { runWorktreeMerge } from './merge/runWorktreeMerge.js';

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

// Fast-forward main (in `repoRoot`) to the tip of `branchName`. Auto-
// stashes a dirty working tree before the FF and pops it afterwards.
// Used after the in-worktree merge succeeds so the resolved branch tip
// becomes main's new tip without ever putting conflict markers in main's
// working files.
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
    const snapshot = await snapshotWorkingTree(repoRoot, `fastfwd-${branchName}`);
    return { ok: true, snapshot };
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
      ok: false,
      outcome: {
        status: 'error',
        message:
          `Fast-forward of main to ${branchName} failed: ` +
          (ff.stderr.trim() ||
            ff.stdout.trim() ||
            'git merge --ff-only failed'),
      },
    };
  }
  return { ok: true };
}

// Phase 3 — restore the snapshot after a successful FF. HEAD has moved;
// restore copies the user's snapshotted versions back over whatever the FF
// brought in for those paths. This is last-writer-wins (snapshot wins on
// overlap) — see snapshot.ts header for the rationale. No "conflict"
// outcome here, unlike the old stash-pop path; if the user really had
// overlapping changes they'll see them as a dirty working tree post-restore
// and can reconcile with `git diff`. A restore failure is logged, not
// fatal — the FF already landed.
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
