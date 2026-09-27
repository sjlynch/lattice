# backend/src/worktree/merge

Helper steps for a **single-task merge attempt**, factored out of the sibling
`../merge.ts` FILE.

> **Name-collision hazard:** this `merge/` DIRECTORY ≠ the `../merge.ts` FILE.
> The FILE owns the public orchestrators `mergeWorktreeInRepo` (run `git merge`
> *inside the worktree*, never main's tree) and `fastForwardMain` (FF main to
> the resolved tip). The DIRECTORY holds the per-step helpers the FILE calls.
> Mind which one you're editing — this is the safety-critical merge pipeline.

## Call chain (`mergeWorktreeInRepo` drives it)

1. `preflight.ts` — `preflightWorktreeMerge`: guard rails before any merge —
   `.git` intact, is-a-repo, not already mid-merge, worktree exists; auto-aborts
   an orphan worktree `MERGE_HEAD` from a crashed prior attempt; returns main's
   HEAD sha.
2. `branchState.ts` — `checkBranchState`: classify the branch as
   `already-merged` / `empty` / `ahead` / `error` (a git failure is surfaced as
   `error`, never misread as an empty branch that silently drops the merge).
3. `mergeResidue.ts` — `clearMergeBlockingChanges`: uncommitted changes to
   paths main changed since the merge base (residue of a merge that died
   part-way, or an agent's never-committed edit) would make git refuse. Lattice
   merges the branch's COMMITS, so residue is archived (`../discardArchive.ts`),
   never merged; only the blocking paths are restored. Archive failure → no
   change, `error`. Lattice-managed files are left to step 4's shelve/reset.
4. `runWorktreeMerge.ts` — `runWorktreeMerge`: the actual
   `git merge --no-ff -m <msg> <mainHeadSha>`, shelving/resetting Lattice-owned
   files around it so an accidentally-committed `LATTICE_TASK.md` can't abort it.
   If it fails *without* leaving a merge in progress (not a conflict),
   `restoreFailedMergeWrites` (`mergeResidue.ts`) restores exactly the paths
   that attempt wrote (dirty-now minus dirty-before).
5. `conflict.ts` — `handleMergeConflict` (only when the merge conflicts):
   auto-resolves Lattice-owned files; if they were the *only* conflicts it
   commits and returns `clean`, else returns `conflict` with the remaining
   files (caller spawns a resolver Claude). Re-installs the Stop hook either way.

- `fastForward.ts` — `fastForwardMain` (+ `FF_LOCK_RETRY_DELAYS_MS`), moved out of the FILE and re-exported from it: preflight + scoped snapshot → `projectGit merge --ff-only` (lock-retry) → snapshot restore; the shared `MergeOutcome`/`MergeConflictKind` live in `types.ts`.
