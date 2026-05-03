# backend/src/worktree

Git-worktree subsystem. Public surface is re-exported from `../worktree.ts` (the shim).

## Modules

- `exec.ts` — spawn helper with hard timeout. All git invocations go through this.
- `setup.ts` — `setupTaskWorktree` creates `.lattice/worktrees/<slug>-<id>` + branch + `LATTICE_TASK.md` + `.claude/settings.local.json` Stop hook. Also `parseWorktreesPorcelain` (tested).
- `commands.ts` — pure command-string builders (claude/pi, run/resume/conflict/stash). No I/O.
- `instructions.ts` — markdown writers for `LATTICE_TASK.md`, `MERGE_INSTRUCTIONS.md`, `STASH_CONFLICT_*.md`.
- `state.ts` — read-only checks: `isMidMerge`, `worktreeExists`, branch reachability + commit counts.
- `merge.ts` — `mergeWorktreeInRepo` runs `git merge` *inside the worktree* (so main's vite-watched files never see conflict markers); `fastForwardMain` brings main forward after.
- `stash.ts` — auto-stash/pop helpers + `RUN_STASH_LABEL` for the run-level pre-flight stash.
- `finalize.ts` — `finalizeMergedTask`: FF main, write `qa` crash-safe, schedule background cleanup. Per-project promise queue serializes finalizes.
- `cleanup.ts` — kill PTYs by cwd (Windows holds dir locks) → `git worktree remove --force` with timeout → fallback `fs.rm`.

## Critical ordering (finalize.ts)

1. `fastForwardMain` (auto-stashes dirty tree, FFs, pops stash). Stash conflict here surfaces as `{ok: false, stashConflict}`.
2. `updateTaskCrashSafe({status: 'qa', ...})` — disk first, cache second.
3. `scheduleWorktreeCleanup` — runs in a per-project queue **after** finalize returns. Stuck cleanup never blocks the run worker.
