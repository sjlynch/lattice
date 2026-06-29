# backend/src/recovery

Boot-time crash recovery for project/task state. `../recovery.ts` is only the stable public shim; keep implementation here.

## Boot order

1. `restoreAllProjectsFromBackup` — repair task DB files before any task cache read.
2. `recoverPendingSnapshots` — restore copy-based working-tree snapshots left by crashed merge/finalize work.
3. `sweepOrphanedWorktrees` (`worktreeSweep.ts`) — remove only Lattice-managed worktrees that no active task owns.
3a. `sweepOrphanedPushSessions` (`pushSessionSweep.ts`) / `sweepOrphanedQaSessions` (`qaSessionSweep.ts`) / `sweepOrphanedPostMergeHookSessions` (`postMergeHookSweep.ts`) — reclaim home-scoped push / QA-e2e / post-merge-hook scratch dirs whose `/done` cleanup lost its EBUSY race or never fired (the in-memory registries are empty at boot, so anything on disk is stale). All three use `homeScratch/sweep.ts`, preserve dirs with a live PTY cwd, and are bounded to `~/.lattice/per-project/<hash>/{push,qa,post-merge-hooks}/`.
3b. `sweepStaleClaudeProjectEntries` (`claudeConfigSweep.ts`) — prune dead `projects[<cwd>]` entries from `~/.claude.json` whose key is a Lattice ephemeral worktree/scratch cwd (`~/.lattice/...` or a legacy `<repo>/.lattice/worktrees/...`) that no longer exists on disk. Each spawn pre-seeds one such entry (trust + managed MCP) and nothing else removes them, so the map grew unbounded; this is the analogue of the dir sweeps. Runs *after* them so entries for just-reclaimed dirs are caught too. GLOBAL (one shared file), serialized through `claudeTrust.ts`'s mkdir mutex. A live session's cwd still exists, so it's left alone. (The long-lived terminal-server *also* runs this prune on a 5-min timer, since it outlives many main-backend boots and is what accumulates the entries.)
3c. `sweepOrphanedClaudeConfigTempFiles` (`claudeConfigSweep.ts` → `claudeTrust.sweepOrphanedClaudeConfigTemps`) — delete orphaned `~/.claude.json.lattice-<pid>-<ts>.tmp` (and the analogous `mcpSecrets.json` temps) left when a writer was hard-killed between its temp write and the rename. Skips temps newer than 60s so a live terminal-server's in-flight write is never touched. The fixed atomic-write path now unlinks its temp on a failed rename, so this mostly reclaims legacy orphans (one real pile reached ~8MB). GLOBAL (one shared home dir).
4. Branch repair (`index.ts`) — `ready_to_merge` tasks whose branch is gone are marked `qa` because finalize cleanup already ran.
5. `resumeInterruptedMergeRuns` (`mergeRunResume.ts`) — called after HTTP listen so spawned resolvers can call the API.
6. `resumeQueuedTaskRuns` (`queuedRunResume.ts`) — also called after HTTP listen. Re-enqueues task runs that were waiting in the in-memory spawn queue when the backend stopped (found via the persisted `Task.runQueued` flag). Runs *after* `sweepOrphanedWorktrees` so a worktree half-created by an interrupted run is reconciled by the re-run, not reclaimed as an orphan.

## Periodic sweeps (not boot-time)

`inProgressSweep.ts` is a stable facade (re-exported from `index.ts`) over the
`inProgressSweep/` subfolder. Unlike the boot sweeps above, it runs on a timer
(`startInProgressSweepLoop` / `stopInProgressSweepLoop`, default
`IN_PROGRESS_SWEEP_INTERVAL_MS = 60s`), complementing boot recovery from the
other end: an `in_progress` task whose PTY is dead **and** whose branch has a
commit gets auto-completed (in_progress → ready_to_merge), since the Pi
extension / explicit `/complete` curl are both best-effort and can be missed.

Split by concern so the eligibility decision is auditable in isolation:

- `config.ts` — the age gate (`MIN_AGE_MS`) + loop interval knobs.
- `scheduler.ts` — timer lifecycle only (module-scoped handle, `unref`'d).
- `sweep.ts` — project/task scanning: snapshot live session cwds once, walk
  every known project's `in_progress` tasks, and translate each verdict into
  logging + skip-accounting + the mutation. Owns the `SweepResult` shape.
- `eligibility.ts` — `decideAutoComplete(...)` returns a discriminated
  `EligibilityVerdict` (`skip` with a typed `SkipReason`, or `complete`). Read
  only; no mutation. `too-young` / `session-live` skips are the expected-healthy
  cases (silent, uncounted); the rest are surfaced.
- `complete.ts` — the auto-complete mutation: read the Pi shutdown sentinel for
  the diagnostic log, then `updateTask` to `ready_to_merge`.

## Safety invariants

- Keep recovery best-effort: log a failed phase/project and continue booting.
- Project iteration must go through `forEachKnownProjectSafely` so one broken project cannot block others.
- Do not add raw recursive deletes here; worktree removal goes through `cleanupWorktreeForTask` / `git worktree remove`.
- Do not run stale merge-run resume before the server is listening.
