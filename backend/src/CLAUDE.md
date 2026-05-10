# backend/src

Express server (`:5184`) plus a detached PTY subprocess on `:5185`.

## Layout

- `index.ts` — bootstrap. Mounts route modules from `routes/`, attaches WS via `ws/wsServer.ts`, runs `recovery.ts` before listen.
- `recovery.ts` — boot recovery: restore tasks.json from backup → restore orphan working-tree snapshots → **`sweepOrphanedWorktrees`** (reclaim worktrees git tracks that no live task owns) → recover ready_to_merge tasks whose branch was deleted.
- `routes/` — one router per domain (tasks, mergeRuns, workflows, settings, terminals, health). Each is a `buildXRouter()` factory.
- `ws/wsServer.ts` — single `upgrade` dispatcher. Adding a WS endpoint = add a route in `attachWebSockets`.
- `worktree/` — git-worktree subsystem (see its `CLAUDE.md`). The `worktree.ts` shim re-exports the public surface. Includes `projectGit` (whitelisted git wrapper for the project repo) and `gitBackup` (`git bundle` pre-run backup).
- `projectPath.ts` — `canonicalProjectPath`, `projectHash`, `homeWorktreesDir` — the single source of truth for per-project paths under `~/.lattice/`.
- `projectRunLock.ts` — cross-process per-project lock (`~/.lattice/per-project/<hash>/run.lock`, PID-liveness probe). Held for the duration of a merge run / manual `/merge`. The in-process guards (mergeRuns singleton, `mergeLocks`) don't see other Lattice processes; this does.
- `tasks.ts` — in-memory cache + 100 ms debounced persist. Storage lives at `~/.lattice/per-project/<sha1(canonical-path)[:12]>/tasks.json` (moved out of `<project>/.lattice/` after the 2026-05-09 incident — keeps task data alive when a project-side catastrophe wipes the project dir). On first read of a project, the legacy in-project `<project>/.lattice/tasks.json` is auto-copied into the home location; legacy file is left in place for rollback. `updateTaskCrashSafe` writes to disk before mutating cache.
- `mergeRuns.ts` / `workflowRuns.ts` — sequential run engines. `mergeRuns` also: takes a `git bundle` backup pre-run, holds the cross-process run lock, and runs a circuit-breaker (`.git`-exists + HEAD-only-forward) between tasks that halts the whole run on a violation. Singleton WS subscribers (`subscribe`) for live event fan-out.
- `terminalProxy.ts` / `terminal-server.ts` / `terminal.ts` — PTY lives in a detached child so main-server restarts don't kill running Claude sessions.
- `processGuards.ts` — swallows node-pty's known Windows cleanup throw; everything else logs and continues.

## Key invariants

- **One active merge run per project** — in-process (mergeRuns.ts, second start returns 409) *and* cross-process (`projectRunLock.ts`).
- **Per-task merge lock** (`mergeLocks.ts`) — manual /merge can't race the run worker.
- **Crash-safe ordering**: `updateTaskCrashSafe` writes disk before cache. Used for `ready_to_merge → qa` transitions.
- **Merge in worktree, not main** — see `worktree/merge.ts`. Main's tree only ever changes via fast-forward.
- **All project-repo git goes through `projectGit`** — never raw `exec('git', …, repoRoot)`. Worktree-side git stays on `exec` (disposable, and it needs the real `git merge` that `projectGit` forbids).
- **No `fs.rm({recursive})` on anything inside a project** — worktrees live outside the project tree; worktree teardown delegates the recursive delete to `git worktree remove`.

## Type-check

`npx tsc --noEmit` from `backend/`. Tests: `npm test` (node:test, runs `src/__tests__/*.test.ts`).
