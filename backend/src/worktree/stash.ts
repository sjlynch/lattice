// Working-tree preservation across FF/merge.
//
// Despite the filename, this module no longer uses `git stash`. It keeps
// the legacy name only because mergeRuns / instructions / log lines still
// reference symbols that originated here. Internally everything delegates
// to the copy-based snapshot in ./snapshot.ts.
//
// The motivating change: `git stash --include-untracked` silently deletes
// every captured path if the stash is later lost — by a crashed pop, a
// dropped entry, or a process kill mid-stash. Two real .git-deletion
// incidents on this project (2026-05-08, 2026-05-09) traced back to that
// failure mode. Copy-to-disk snapshots are recoverable even when the
// process dies in the middle.

import { gitDirExists } from './state.js';
import {
  ensureLatticeRepoExclude,
  verifyEssentialExclusions,
} from './setup.js';
import {
  snapshotWorkingTree,
  restoreSnapshot,
  type SnapshotHandle,
} from './snapshot.js';

// Label used for the run-level snapshot directory name. Kept under the
// old constant name so instructions.ts and existing log lines don't
// change. The label survives in the snapshot dir basename
// (`<timestamp>-<label>/`) so a developer browsing
// ~/.lattice/snapshots/ can tell run-level from per-task snapshots.
export const RUN_STASH_LABEL = 'lattice-run-stash';

export type { SnapshotHandle } from './snapshot.js';
export {
  snapshotWorkingTree,
  restoreSnapshot,
  recoverPendingSnapshots,
} from './snapshot.js';

// Preflight gate before any working-tree-mutating operation. Throws if:
//
//   1. `.git` is missing entirely. Pressing on lets git walk up the file
//      system and latch onto a different repo's gitdir, which is exactly
//      how the prior catastrophic incidents started.
//
//   2. `.lattice/` is not excluded by .gitignore / .git/info/exclude.
//      Even though we no longer use `git stash --include-untracked`,
//      `git status` (used by the snapshot to list untracked files) would
//      otherwise report every nested `.lattice/worktrees/<id>/` (each a
//      separate git checkout) as untracked, and the snapshot would try to
//      copy them — pointless and slow.
//
// As a self-heal step we (re)write `.git/info/exclude` to cover
// `.lattice/` before re-checking. info/exclude lives inside the gitdir,
// is never tracked, and is never touched by snapshots — so it stays in
// place across runs regardless of whether the project's tracked
// `.gitignore` has the entry.
export async function assertSafeForStash(repoRoot: string): Promise<void> {
  if (!(await gitDirExists(repoRoot))) {
    throw new Error(
      `Refusing to operate: ${repoRoot}/.git is missing. Restore the ` +
        `repository before running another merge.`,
    );
  }
  // Self-heal info/exclude (the durable layer). The .gitignore equivalent
  // is intentionally NOT applied here — modifying a tracked file mid-run
  // is what created the original failure mode (see snapshot.ts header).
  await ensureLatticeRepoExclude(repoRoot);
  const v = await verifyEssentialExclusions(repoRoot);
  if (!v.ok) {
    throw new Error(
      `Refusing to operate: paths still not git-ignored after self-heal — ` +
        `${v.missing.join(', ')}. The snapshot would otherwise enumerate ` +
        `every nested git checkout under those paths.`,
    );
  }
}

// Snapshot the working tree at the start of a merge run.
// Throws on missing .git or unexcluded essentials.
export async function snapshotForRun(repoRoot: string): Promise<SnapshotHandle> {
  await assertSafeForStash(repoRoot);
  return snapshotWorkingTree(repoRoot, RUN_STASH_LABEL);
}
