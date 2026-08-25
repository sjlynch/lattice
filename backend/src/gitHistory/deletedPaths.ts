// Which of the paths in the loaded history no longer exist.
//
// The timeline's ghost nodes (grey disc + red ring) are meant to be exactly the
// files git history mentions that are gone from the tree. The obvious
// client-side shortcut — "a history path that isn't in the scan must be
// deleted" — is wrong twice over, so the answer is computed here from git
// itself and shipped with the history:
//
//   1. The scan only collects `SOURCE_EXTS` files, while `git log
//      --name-status` is unfiltered. Every tracked image, font, `.ico`, and
//      extension-less name (`.gitignore`) is absent from the scan while very
//      much still on disk.
//   2. "The path's newest status in log order is D" is no better. `git log`
//      orders by commit date and `--no-merges` drops the merge commits, so in
//      any repo with parallel branches — which is Lattice's entire operating
//      model — a sibling branch's `M` can sort after the branch that actually
//      deleted the file, hiding a genuine deletion. (Observed in Lattice's own
//      history: two children of the same parent, 36 minutes apart.)
//
// `git ls-files` answers it directly and without ordering assumptions: it lists
// the index, so it already accounts for staged adds and staged deletes. The one
// thing it can't see is a tracked file deleted in the working tree but not yet
// staged — that shows up as a `D` in the porcelain status, which we subtract.

import type { GitCommit, GitUncommitted } from './types.js';

export function computeDeletedPaths(
  commits: GitCommit[],
  uncommitted: GitUncommitted,
  // `null` means the tracked-file probe failed. We then report nothing as
  // deleted: dropping the ghosts for one request degrades far more gracefully
  // than an empty set would, which would declare every history path deleted —
  // precisely the false-positive this module exists to prevent.
  tracked: ReadonlySet<string> | null,
): string[] {
  if (!tracked) return [];

  const worktreeDeleted = new Set<string>();
  for (const ch of uncommitted.changes) {
    if (ch.status === 'D') worktreeDeleted.add(ch.path);
  }

  const gone = new Set<string>();
  function consider(filePath: string): void {
    if (worktreeDeleted.has(filePath) || !tracked!.has(filePath)) gone.add(filePath);
  }
  for (const c of commits) for (const ch of c.changes) consider(ch.path);
  for (const ch of uncommitted.changes) consider(ch.path);

  // Sorted so the payload (and the ghost set derived from it) is stable across
  // requests that saw the same repo state.
  return [...gone].sort();
}
