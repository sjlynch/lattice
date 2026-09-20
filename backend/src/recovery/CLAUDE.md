# backend/src/recovery

Boot-time crash recovery for project/task state. `../recovery.ts` is only the stable public shim; keep implementation here.

## Boot order

1. `restoreAllProjectsFromBackup` — repair task DB files before any task cache read.
2. `recoverPendingSnapshots` — restore copy-based working-tree snapshots left by crashed merge/finalize work.
3. `sweepOrphanedWorktrees` (`worktreeSweep.ts`) — remove only Lattice-managed worktrees that no active task owns.
3a. `sweepOrphanedPushSessions` (`pushSessionSweep.ts`) / `sweepOrphanedQaSessions` (`qaSessionSweep.ts`) / `sweepOrphanedPostMergeHookSessions` (`postMergeHookSweep.ts`) — reclaim home-scoped push / QA-e2e / post-merge-hook scratch dirs whose `/done` cleanup lost its EBUSY race or never fired (the in-memory registries are empty at boot, so anything on disk is stale). All three use `homeScratch/sweep.ts`, preserve dirs with a live PTY cwd, and are bounded to `~/.lattice/per-project/<hash>/{push,qa,post-merge-hooks}/`.
3b. `sweepStaleClaudeProjectEntries` (`claudeConfigSweep.ts`) — prune dead `projects[<cwd>]` entries from `~/.claude.json` whose key is a Lattice ephemeral worktree/scratch cwd (`~/.lattice/...` or a legacy `<repo>/.lattice/worktrees/...`) that no longer exists on disk. Each spawn pre-seeds one such entry (trust + managed MCP) and nothing else removes them, so the map grew unbounded; this is the analogue of the dir sweeps. Runs *after* them so entries for just-reclaimed dirs are caught too. GLOBAL (one shared file), serialized through `claudeTrust.ts`'s shared config mutex. A live session's cwd still exists, so it's left alone. (The long-lived terminal-server *also* runs this prune on a 5-min timer, since it outlives many main-backend boots and is what accumulates the entries.)
3c. `sweepOrphanedClaudeConfigTempFiles` (`claudeConfigSweep.ts` → `claudeTrust.sweepOrphanedClaudeConfigTemps`) — delete orphaned `~/.claude.json.lattice-<pid>-<ts>.tmp` (and the analogous `mcpSecrets.json` temps) left when a writer was hard-killed between its temp write and the rename. Skips temps newer than 60s so a live terminal-server's in-flight write is never touched. The fixed atomic-write path now unlinks its temp on a failed rename, so this mostly reclaims legacy orphans (one real pile reached ~8MB). GLOBAL (one shared home dir).
4. Branch repair (`index.ts`) — `ready_to_merge` tasks whose branch is gone are marked `qa` because finalize cleanup already ran. **Only on a confirmed absence**: the project's `.git` must exist and `checkBranchExists` must return exit-0-no-match; a git failure (it throws) or a missing `.git` leaves the task alone, per task (one task's failure never skips the rest). Before this, a transient refs error read as "deleted", the task was moved to `qa` with `branch`/`worktreePath` cleared, and the next boot's orphan sweep deleted the branch — with its unmerged commits — for good.
4a. `resumeInterruptedWorkflowRuns` (`workflowRunResume.ts`) — called after HTTP listen and **before** the merge-run resume. Reads each project's `~/.lattice/per-project/<hash>/workflow-runs.json` mirror (`workflowRuns/persistence.ts`) and applies `classifyWorkflowRunResume` per run: an **agent** step whose pty is still alive in the detached terminal-server is re-adopted (record restored + pty re-attached via `adoptWorkflowStepSession` + presence node re-registered), so the agent's pending `/complete` advances the run as if nothing happened; a **control** step (start/merge/push) died with the process and is re-dispatched (they are re-runnable, same property `resumeInterruptedMergeRuns` relies on); an agent step whose pty is gone is marked **errored** rather than left hanging. One terminal-server probe per sweep; `null` ("couldn't ask") re-adopts, so a wedged terminal-server can't mass-error healthy runs. Ordering is load-bearing: a resumed workflow owns its project's merge pipeline through its own Merge step, so step 5 skips any project with an active workflow run.
5. `resumeInterruptedMergeRuns` (`mergeRunResume.ts`) — called after HTTP listen so spawned resolvers can call the API. Skipped for a project that has an active workflow run (see 4a). Resumes on a stale (dead-PID) run lock whose label is `merge-run` **or** a workflow Merge/Push control step (`workflow-merge:*` / `workflow-push:*` — see `isResumableInterruptedRunLock`), gated on `ready_to_merge` tasks actually remaining. The workflow labels are the important case: a workflow's Merge step holds the per-project lock while it drains In-Progress + merges Ready-to-Merge, and a backend restart/crash in that window kills the in-memory (non-persisted) workflow run **and** skips the lock-releasing `finally`, stranding the completed-but-unmerged tasks. A manual `/merge` (`manual-merge`) and a workflow `Start` lock are deliberately not resumed here.
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
- `scheduler.ts` — timer lifecycle (module-scoped handle, `unref`'d) plus the
  overlap guard: `runInProgressSweepTick` skips a tick while the previous pass
  is still running (a pass is one git spawn per candidate, so a big board or a
  wedged git could outlast the interval and stack passes).
- `sweep.ts` — project/task scanning: snapshot live session cwds once, collect
  every known project's `in_progress` tasks, probe them with bounded fan-out
  (`../concurrency.ts`, 8 wide, per-task error isolation), and translate each
  verdict into logging + skip-accounting + the mutation. Owns the `SweepResult`
  shape. A `no-commits` verdict (pty dead, nothing to flip to) is cached per
  `(taskId, branch)` for `NO_COMMITS_BACKOFF_MS` (10 min) and its warning is
  logged once — that state cannot change until the user resumes the task, and
  re-probing it every minute forever was a git spawn + a log line per stuck
  task per pass.
- `eligibility.ts` — `decideAutoComplete(...)` returns a discriminated
  `EligibilityVerdict` (`skip` with a typed `SkipReason`, or `complete`). Read
  only; no mutation. `too-young` / `session-live` skips are the expected-healthy
  cases (silent, uncounted); the rest are surfaced.
- `complete.ts` — the auto-complete mutation: read the Pi shutdown sentinel for
  the diagnostic log, then `updateTask` to `ready_to_merge`.

## Safety invariants

- `retryBudget.ts` durably charges each automatic workflow redispatch and boot
  merge replay before side effects; three interrupted attempts at unchanged
  checkpoints pause replay with a persisted reason and a run error event.
  Session adoption and durable completion advancement are not replay attempts.
  Workflow step/task-lane progress and remaining merge-task IDs reset budgets.
  Only an explicit user POST `/api/merge-runs` resets the merge allowance;
  internal callbacks and worker auto-restarts must not replenish it.
- A paused workflow's stale control lock must not bypass its budget through the
  independent merge-resume fallback. The journal remains home-scoped; invalid
  journals are preserved and prevent automatic replay. GET
  `/api/merge-runs/recovery?project=...` exposes the retained diagnostic.

- Keep recovery best-effort: log a failed phase/project and continue booting.
- Project iteration must go through `forEachKnownProjectSafely` so one broken project cannot block others. It (and the per-task loops in `index.ts` / the in-progress sweep) fan out with `concurrency.ts`'s `forEachWithConcurrency` (8 wide) — items are independent, and a strictly serial walk of N projects × M tasks, one git spawn each, ran before `listen` and delayed the port by seconds. Keep per-item try/catch inside the callback; the helper does not swallow errors.
- Do not add raw recursive deletes here; worktree removal goes through `cleanupWorktreeForTask` / `git worktree remove`.
- Do not run stale merge-run resume before the server is listening.
- Worktree reclamation requires a readable, nonempty task inventory and an
  authoritative terminal-session inventory. A corrupt task DB may load as an
  empty default, so zero task records must preserve every checkout. Preserve
  queued task checkouts and live PTY cwds (including descendants), and compare
  ownership paths case-insensitively on Windows.
- Honor explicit Git worktree locks and count only successful cleanup as
  reclaimed. Use `worktree list --porcelain -z` to preserve exact paths. Never
  globally prune missing registrations during the sweep: skipped active or
  user-managed checkouts may be temporarily offline. Exact orphan removal
  handles its own registration, including a manually deleted directory.
