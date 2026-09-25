// Fast-forward main to a merged task branch — the second half of a merge,
// after `../merge.ts` `mergeWorktreeInRepo` has merged main INTO the branch
// inside its worktree. Moved here from `../merge.ts`, which re-exports
// `fastForwardMain` and `FF_LOCK_RETRY_DELAYS_MS` from their old path.

import { projectGit } from '../projectGit.js';
import { gitDirExists } from '../state.js';
import { assertSafeForStash } from '../stash.js';
import { mergeDiskSpaceShortfall } from '../diskFull.js';
import {
  describePartialRestore,
  snapshotWorkingTree,
  restoreSnapshot,
  type SnapshotHandle,
} from '../snapshot.js';
import { assertMainOnBranch } from './preflight.js';
import { clearStaleGitLocks, gitLockPathFromError } from '../staleGitLocks.js';
import type { MergeOutcome } from './types.js';

// Back-off before re-trying a fast-forward that collided with another git
// process's lock (an IDE's background `git status`, the user's own command).
export const FF_LOCK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

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
  // A fast-forward on a full disk truncates the files it rewrites and then
  // fails with HEAD unmoved — 2026-09-24 it left two of main's source files
  // zero-byte, which then read as uncommitted edits. Every path (a resolver's
  // finalize too, not only mergeWorktreeInRepo) refuses under the floor.
  const shortfall = await mergeDiskSpaceShortfall([repoRoot]);
  if (shortfall) return { ok: false, outcome: { status: 'error', message: shortfall } };
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

// Phase 3 — restore after a successful FF. Newer dirty edits survive; a
// captured edit to a file the FF also changed is three-way merged with it
// (snapshot/threeWay.ts), and one that overlaps it keeps the FF's version with
// the captured copy saved beside it as `.lattice-conflict`. A partial restore
// returns a warning that finalize surfaces without retrying the landed FF.
async function restoreAfterFastForward(
  repoRoot: string,
  snapshot: SnapshotHandle | undefined,
): Promise<string | undefined> {
  if (snapshot && snapshot.dir) {
    try {
      const restored = await restoreSnapshot(snapshot, repoRoot);
      if (restored.status === 'restored') return;
      const warning = describePartialRestore(restored, snapshot.dir);
      console.warn(`[fastForwardMain] ${warning}`);
      return warning;
    } catch (err) {
      const warning = `Snapshot restore failed; captured versions retained at ${snapshot.dir}: ${(err as Error).message}`;
      console.warn(`[fastForwardMain] ${warning}`);
      return warning;
    }
  }
}
