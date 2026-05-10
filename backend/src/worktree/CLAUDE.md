# backend/src/worktree

Git-worktree subsystem. Public surface is re-exported from `../worktree.ts` (the shim).

## Modules

- `exec.ts` — spawn helper with hard timeout. Worktree-side git invocations go through this directly; project-repo git calls go through `projectGit` (below).
- `projectGit.ts` — **`projectGit(repoRoot, args)`**: the only sanctioned way to run git against the user's project repo. Asserts `<repoRoot>/.git` exists, then validates argv against a whitelist (reads, `add`/`commit`/`rm --cached`, `worktree add|remove|prune`, `branch -D lattice/*`, `merge --ff-only`, `checkout … -- <explicit paths>`, `reset … -- <paths>`, `bundle`). Rejects `clean`, `stash`, `reset --hard`, `update-ref -d`, non-ff `merge`, `branch -D <non-lattice>`, `checkout <branch>`, `push`, leading `-C/-c`, … — *before* git runs. `assertAllowedProjectGitArgs` is unit-tested.
- `gitBackup.ts` — `backupProjectGitBundle(repoRoot)`: `git bundle create ~/.lattice/git-backups/<hash>/<ts>.bundle --all`, keeps last 5. Called once per merge run (pre-flight). Recovery = `git fetch <bundle>`.
- `setup.ts` — `setupTaskWorktree(repoPath, task, backendOrigin, harness)` creates the worktree at **`~/.lattice/worktrees/<projectHash>/<slug>-<id>`** (outside the project tree — the headline fix for the recurring `.git` deletions) + branch `lattice/<slug>-<id>` + `LATTICE_TASK.md` (worded per `harness` — non-Claude harnesses get an explicit "curl `/complete` as your final step") + `.claude/settings.local.json` Stop hook (always — a Pi/Codex task that conflicts is resolved by a Claude resolver) + (`harness === 'pi'` only) `.pi/extensions/lattice-complete.ts`, a Pi extension that POSTs `/complete` on `session_shutdown` — Pi has no command-hook mechanism, but auto-loads `.pi/extensions/*.ts` in Node. Also `ensureLatticeGitignore` / `ensureLatticeRepoExclude` / `untrackOwnedFilesInRepo` / `verifyEssentialExclusions`. All its git calls go through `projectGit`.
- `commands.ts` — pure command-string builders (claude/pi/codex, run/resume/conflict/stash). No I/O.
- `instructions.ts` — markdown writers for `LATTICE_TASK.md`, `MERGE_INSTRUCTIONS.md`, `STASH_CONFLICT_*.md`.
- `state.ts` — read-only checks: `isMidMerge`, `worktreeExists`, `gitDirExists`/`assertGitDirIntact`, branch reachability + commit counts, `parseWorktreesPorcelain` (tested). Read-only ⇒ plain `exec`, not `projectGit`.
- `snapshot.ts` — copy-based working-tree snapshot (replaces `git stash --include-untracked`). `snapshotWorkingTree` copies dirty paths to `~/.lattice/snapshots/<hash>/<ts>-<label>/` then resets the tree; `restoreSnapshot` copies them back (last-writer-wins, never deletes). Paths are validated to stay inside the repo; `recoverPendingSnapshots` (boot) restores orphans and refuses tampered manifests.
- `merge.ts` — `mergeWorktreeInRepo` runs `git merge` *inside the worktree* (so main's vite-watched files never see conflict markers); `fastForwardMain` snapshots the tree, FF's main via `projectGit … merge --ff-only`, restores the snapshot.
- `stash.ts` — legacy name; delegates entirely to `snapshot.ts`. Keeps `RUN_STASH_LABEL` + `assertSafeForStash` (self-heals `.git/info/exclude`, verifies `.lattice/`+`node_modules/` are ignored).
- `finalize.ts` — `finalizeMergedTask`: FF main, write `qa` crash-safe, schedule background cleanup. Per-project promise queue serializes finalizes.
- `cleanup.ts` — `cleanupWorktreeForTask`: kill PTYs by cwd (Windows holds dir locks) → `git worktree remove --force` (via `projectGit`, with timeout) → `git branch -D` (only `lattice/*`) → `git worktree prune`. **No raw `fs.rm` fallback** — if `git worktree remove` fails, the dir is left in place (inert, since it's outside the project) and the boot-time `sweepOrphanedWorktrees` retries it. Also `assertNotReparsePoint` (symlink/junction guard, used by setup.ts's reconcile fs.rm) and `isUnderManagedWorktreesDir`.

## Defence in depth against `.git` deletion

The only mechanism that has ever deleted `.git` is a recursive filesystem delete reaching it (directly via `fs.rm`, or via a lost `git stash --include-untracked`). Layers, outermost first:

1. **Worktrees live outside the project** (`~/.lattice/worktrees/<hash>/`) — no worktree-path `fs.rm` Lattice issues can be an ancestor/descendant of `<repo>/.git`.
2. **`projectGit` capability whitelist** — a destructive git subcommand against the project repo throws before running.
3. **No `fs.rm` fallback in cleanup** — recursive worktree removal is delegated to `git worktree remove`, which knows the exact dir and won't follow symlinks out.
4. **Copy-based snapshots** — no `git stash`; a crash leaves a recoverable snapshot dir, never a silent delete.
5. **Run circuit breaker** (mergeRuns.ts) — `.git`-exists + HEAD-only-moved-forward check after every task; a violation halts the whole run.
6. **`git bundle --all` pre-run backup** — last-resort full-history recovery.
7. Plus: reparse-point guard on the remaining fs.rm sites, snapshot-manifest path validation, cross-process project run lock.

## Critical ordering (finalize.ts)

1. `fastForwardMain` (snapshots dirty tree, FFs, restores snapshot). Returns `{status:'error'}` or `{status:'clean'}` — never a conflict.
2. `updateTaskCrashSafe({status: 'qa', ...})` — disk first, cache second.
3. `scheduleWorktreeCleanup` — runs in a per-project queue **after** finalize returns. Stuck cleanup never blocks the run worker; the boot sweep mops up anything it leaves.
