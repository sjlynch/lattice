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
3. `runWorktreeMerge.ts` — `runWorktreeMerge`: the actual
   `git merge --no-ff -m <msg> <mainHeadSha>`, shelving/resetting Lattice-owned
   files around it so an accidentally-committed `LATTICE_TASK.md` can't abort it.
4. `conflict.ts` — `handleMergeConflict` (only when the merge conflicts):
   auto-resolves Lattice-owned files; if they were the *only* conflicts it
   commits and returns `clean`, else returns `conflict` with the remaining
   files (caller spawns a resolver Claude). Re-installs the Stop hook either way.
