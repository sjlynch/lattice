# backend/src/recovery

Boot-time crash recovery for project/task state. `../recovery.ts` is only the stable public shim; keep implementation here.

## Boot order

1. `restoreAllProjectsFromBackup` — repair task DB files before any task cache read.
2. `recoverPendingSnapshots` — restore copy-based working-tree snapshots left by crashed merge/finalize work.
3. `sweepOrphanedWorktrees` (`worktreeSweep.ts`) — remove only Lattice-managed worktrees that no active task owns. An orphan with uncommitted edits is first archived to `~/.lattice/snapshots/<hash>/…-discarded-worktree-<slug>-…/` (`worktree/discardArchive.ts`; never auto-restored by step 2); if the archive fails the orphan is left in place. **Runs after listen, not awaited** (`startBootWorktreeSweep`, started from `server/startup.ts`; `resumeQueuedTaskRuns` waits for it): a machine updated from an old version carried 1000+ orphans and the pre-listen sweep kept the UI on "Scanning…". Unmerged `lattice/*` branches are found with ONE `for-each-ref --no-merged=HEAD` (per-branch `rev-list` only if that fails; unreadable = unmerged). An orphan whose branch has unmerged commits keeps its **branch** (`keepBranchIfUnmerged` — the only copy of the work) but loses its **checkout** — unless its task is Open/Backlog (may be re-run), which keeps both. Two removals at a time; one summary line per project listing kept branches (`git branch --list "lattice/*" --no-merged`).
   It then (detached — boot never waits) runs `sweepWorktreeResidue` (`worktreeResidueSweep.ts`): a `git worktree remove --force` that fails part-way on Windows (a locked file — pnpm hard links to a *running* `esbuild.exe` / `rollup.*.node`, or a dev server / vitest started from the worktree) still drops the registration and `.git`, leaving a directory (source dirs too, not just `node_modules`) neither cleanup nor this sweep can see again. The residue sweep removes only direct children of `~/.lattice/worktrees/<hash>/` of a known project that are unregistered, unowned by an active/queued task, have no live pty, no `.git` marker (or only a `.git` FILE whose `gitdir:` names a `<commonDir>/worktrees/<id>` of this repo that no longer exists while the common dir is intact — git's remove stopped at a locked entry sorting before `.git`, e.g. under `.claude/`, after dropping the admin dir), are not a reparse point, and are older than 10 min — the same "verified unregistered home-scoped stray" carve-out `worktree/reconcile.ts` has for its `fs.rm`, including its re-check of `.git` + registration immediately before each delete. Guarded removal (reparse checks first); each removed dir's top-level entries are logged; a locked dir backs off in memory (30 min, doubling, capped at 8 h); one summary line per project only when the counts change; `notifyDiskSpaceFreed()` after any attempt. Unknown projects' hash dirs and legacy `<repo>/.lattice/worktrees` are never touched. The same sweep also runs periodically — see below.
3a. `resumeInterruptedOneOffRuns` (`oneOffRunResume.ts`) — **before listen**, so a callback (or the callback outbox's replay) never meets an unknown id. Push runs, QA e2e runs and post-merge hooks mirror their RUNNING records to `~/.lattice/per-project/<hash>/{push-runs,qa-runs,post-merge-hooks}.json` (`homeScratch/persistence.ts`); their agents survive a restart in the detached terminal-server, and with in-memory-only registries a restart used to 404 their `/done` / `/verdict` / `/complete`, idle the terminal forever, drop a QA pass's qa → done, and let a resumed merge run fire a second post-merge hook (or Phase C read "idle" beside the orphan). One terminal-server probe; per record, a pty found at its scratch cwd — or an unprobeable server (`null`: can't tell ≠ gone) — is **re-adopted**: record restored, presence node re-registered, and for a post-merge hook the one-running-per-project state back (a resumed merge run / Phase C await it), `markAgentReadopted` on its quiescence state, and the merge's bounded wait re-armed. A pty that is gone is restored too but settled as **lost** after `LOST_SETTLE_GRACE_MS` (90 s) unless its callback lands first (the outbox replays a Stop that fired while the backend was down): push → `lost` + done (never attachable by a re-dispatched Push step, which fails rather than reporting success if its attached session is lost); QA → the recorded verdict applied as `/done` would (a confident PASS still promotes), then done; post-merge hook → ended `errored` (waiters released). A small liveness watch (every 30 s, unref'd, stops when empty, skips a pass on an unprobeable server) applies the same settlement to a re-adopted run whose pty later dies without calling back. Pure policy: `classifyOneOffRunResume`.
3b. `sweepOrphanedPushSessions` (`pushSessionSweep.ts`) / `sweepOrphanedQaSessions` (`qaSessionSweep.ts`) / `sweepOrphanedPostMergeHookSessions` (`postMergeHookSweep.ts`) — reclaim home-scoped push / QA-e2e / post-merge-hook scratch dirs whose `/done` cleanup lost its EBUSY race or never fired, or whose session did not survive the restart (3a already re-adopted every live one, so a dir with no live PTY is stale). All three use `homeScratch/sweep.ts`, preserve dirs with a live PTY cwd, and are bounded to `~/.lattice/per-project/<hash>/{push,qa,post-merge-hooks}/`.
3c. `sweepStaleClaudeProjectEntries` (`claudeConfigSweep.ts`) — prune dead `projects[<cwd>]` entries from `~/.claude.json` whose key is a Lattice ephemeral worktree/scratch cwd (`~/.lattice/...` or a legacy `<repo>/.lattice/worktrees/...`) that no longer exists on disk. Each spawn pre-seeds one such entry (trust + managed MCP) and nothing else removes them, so the map grew unbounded; this is the analogue of the dir sweeps. Runs *after* them so entries for just-reclaimed dirs are caught too. GLOBAL (one shared file), serialized through `claudeTrust.ts`'s shared config mutex. A live session's cwd still exists, so it's left alone. (The long-lived terminal-server *also* runs this prune on a 5-min timer, since it outlives many main-backend boots and is what accumulates the entries.)
3d. `sweepOrphanedClaudeConfigTempFiles` (`claudeConfigSweep.ts` → `claudeTrust.sweepOrphanedClaudeConfigTemps`) — delete orphaned `~/.claude.json.lattice-<pid>-<ts>.tmp` (and the analogous `mcpSecrets.json` temps) left when a writer was hard-killed between its temp write and the rename. Skips temps newer than 60s so a live terminal-server's in-flight write is never touched. The fixed atomic-write path now unlinks its temp on a failed rename, so this mostly reclaims legacy orphans (one real pile reached ~8MB). GLOBAL (one shared home dir).
4. Branch repair (`index.ts`) — `ready_to_merge` tasks whose branch is gone are marked `qa` because finalize cleanup already ran. **Only on a confirmed absence**: the project's `.git` must exist and `checkBranchExists` must return exit-0-no-match; a git failure (it throws) or a missing `.git` leaves the task alone, per task (one task's failure never skips the rest). Before this, a transient refs error read as "deleted", the task was moved to `qa` with `branch`/`worktreePath` cleared, and the next boot's orphan sweep deleted the branch — with its unmerged commits — for good.
4a. `resumeInterruptedWorkflowRuns` (`workflowRunResume.ts`) — called after HTTP listen and **before** the merge-run resume. Reads each project's `~/.lattice/per-project/<hash>/workflow-runs.json` mirror (`workflowRuns/persistence.ts`) and applies `classifyWorkflowRunResume` per run: an **agent** step whose pty is still alive in the detached terminal-server is re-adopted (record restored + pty re-attached via `adoptWorkflowStepSession` + presence node re-registered), so the agent's pending `/complete` advances the run as if nothing happened; a **control** step (start/merge/push) died with the process and is re-dispatched (they are re-runnable, same property `resumeInterruptedMergeRuns` relies on); an agent step whose pty is gone is marked **errored** rather than left hanging. One terminal-server probe per sweep; `null` ("couldn't ask") re-adopts, so a wedged terminal-server can't mass-error healthy runs. A re-adopted step's quiescence state is marked `markAgentReadopted` (at registration, before callbacks are released): its live-subagent tracking died with the old process, so its Stop-hook gate needs `READOPTED_SETTLE_MS` (2 min) of silence instead of a few seconds — see `agentQuiescence.ts`; any other outcome drops the mark. A step whose Stop the dead process was still holding in its gate (`run.stopReceived` for the current step) has that gate re-armed here, with the quiet window counted from the Stop — the hook already got its 200 and the idle agent will never Stop again (3a does the same for a post-merge hook's `stopReceivedAt`). A re-dispatched **Push** step re-attaches to its still-live push session (3a re-adopted it) rather than spawning a second push. Ordering is load-bearing: a resumed workflow owns its project's merge pipeline through its own Merge step, so step 5 skips any project with an active workflow run. The sweep settles per run once its dispatch decision is applied — a re-dispatched (or `complete`-advanced) agent step counts as dispatched when it reaches its pre-run (`waitForStepPreRunBegin`, `workflowRuns/stepTools.ts`), so an Opengrep scan of several minutes carries on detached instead of holding the merge-run resume, owed post-merge hooks and outbox replay behind it.
5. `resumeInterruptedMergeRuns` (`mergeRunResume.ts`) — called after HTTP listen so spawned resolvers can call the API. Skipped for a project that has an active workflow run (see 4a). Resumes on a stale (dead-PID) run lock whose label is `merge-run` **or** a workflow Merge/Push control step (`workflow-merge:*` / `workflow-push:*` — see `isResumableInterruptedRunLock`), gated on `ready_to_merge` tasks actually remaining. The workflow labels are the important case: a workflow's Merge step holds the per-project lock while it drains In-Progress + merges Ready-to-Merge, and a backend restart/crash in that window kills the in-process control step **and** skips the lock-releasing `finally`. The workflow run record itself is now re-adopted by 4a (which re-dispatches that control step, and this step then skips the project); this label match remains the fallback for a run whose mirror is gone or paused, so the completed-but-unmerged tasks are never stranded. A manual `/merge` (`manual-merge`) and a workflow `Start` lock are deliberately not resumed here.
5a. `fireOwedPostMergeHooks` (`owedPostMergeHooks.ts`) — after 4a + 5: a project whose last merge landed but whose post-merge hook never fired before the backend died (`postMergeHooks/owed.ts` marker) gets it now, unless an active merge run (its teardown fires it) or workflow run (its Merge step's Phase C does) owns the project.
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
- `complete.ts` — the auto-complete mutation: re-read the task and bail
  (`stale`, silent, retried next pass) if it changed since the pass snapshotted
  it (`updatedAt`/status/worktree/branch — a Resume, lane move or real
  `/complete` landing during the git probe must not be overwritten), read the
  Pi shutdown sentinel for the diagnostic log, then `updateTaskCrashSafe` to
  `ready_to_merge`.

`worktreeResidueSweepLoop.ts` — the residue sweep's non-boot passes: every
`WORKTREE_RESIDUE_SWEEP_INTERVAL_MS` (30 min, `startWorktreeResidueSweepLoop`,
unref'd, started after listen in `server/startup.ts`) and on a disk wait
(`requestWorktreeResidueSweep` from `diskPressureMerge.ts`'s
`requestMergeToFreeDiskSpace`, coalesced to one pass per 2 min). Single-flight
(a second request joins the running pass; a per-project guard inside
`sweepWorktreeResidue` also keeps it off a project the boot pass is still on).
Iterates `forEachKnownProjectSafely`, skips a project with no `.git` or zero
task records, and skips the whole pass when the terminal-server is unreachable
(the live-pty check can't be trusted). Logs with `[residue-sweep]`, not
`[startup]`.

## Safety invariants

- `retryBudget.ts` durably charges each automatic workflow redispatch and boot
  merge replay before side effects; three interrupted attempts at unchanged
  checkpoints pause replay with a persisted reason and a run error event.
  Session adoption and durable completion advancement are not replay attempts.
  That includes a control-step re-run whose work is done and that only
  waits on a session boot just re-adopted — a Merge step with In-Progress and
  Ready-to-Merge empty waiting out a live post-merge hook, a Push step
  re-attaching to its live push session (`workflowRunResume.ts`
  `waitingOnLiveSession`): its checkpoint cannot move while that agent works,
  and charging it paused a healthy run after three restarts.
  Workflow step/task-lane progress and remaining merge-task IDs reset budgets.
  Only an explicit user POST `/api/merge-runs` resets the merge allowance;
  internal callbacks and worker auto-restarts must not replenish it.
- A paused workflow's stale control lock must not bypass its budget through the
  independent merge-resume fallback. The journal remains home-scoped; invalid
  journals are preserved and prevent automatic replay (but never block an
  explicit POST `/api/merge-runs`: its failed budget reset is logged and the
  run proceeds, leaving the invalid file in place). GET
  `/api/merge-runs/recovery?project=...` exposes the retained diagnostic.

- Keep recovery best-effort: log a failed phase/project and continue booting.
- Project iteration must go through `forEachKnownProjectSafely` so one broken project cannot block others. It (and the per-task loops in `index.ts` / the in-progress sweep) fan out with `concurrency.ts`'s `forEachWithConcurrency` (8 wide) — items are independent, and a strictly serial walk of N projects × M tasks, one git spawn each, ran before `listen` and delayed the port by seconds. Keep per-item try/catch inside the callback; the helper does not swallow errors.
- Do not add raw recursive deletes here; worktree removal goes through `cleanupWorktreeForTask` / `git worktree remove`. The one exception is `worktreeResidueSweep.ts` (unregistered direct children of a known project's home worktrees dir with no `.git` or only a dangling worktree `.git` file, re-checked right before the guarded `fs.rm`) — do not widen what it may delete.
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
