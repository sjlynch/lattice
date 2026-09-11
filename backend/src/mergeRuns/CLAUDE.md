# backend/src/mergeRuns

Helper modules for the backend merge-all engine. `../mergeRuns.ts` owns the
public singleton API and worker loop; keep cross-module contracts documented
here instead of bloating the parent file.

- `types.ts` — persisted merge-run records, event payload types, status/error
  types, and the conflict-waiter entry shape.
- `snapshot.ts` — clone helpers for run snapshots; keep array/object cloning
  here so subscriber and persistence snapshots stay auditably identical.
- `normalization.ts` — legacy/interrupted-run deserialization for
  `merge-runs.json`; running runs loaded from disk become errored because the
  owning worker died with the previous backend process.
- `conflictWaiters.ts` — the in-process resolver waiter registry. It remains
  keyed by **taskId** (not runId): a resolver Stop hook is for one conflict
  task, and task-id signalling prevents task A from unblocking task B. Three
  releases: `signal(taskId)` (a real completion — /complete/merged/merge-aborted),
  `unblockRun(runId)` (cancelRun), and `abandon(taskId, runId)` (the liveness
  backstop — NOT a real completion; runId-guarded so a re-queued task's fresh
  waiter isn't dropped).
- `waiterLiveness.ts` — `awaitResolverWaiter`: the bounded-lifetime wrapper the
  park sites await instead of the raw untimed `registerConflictWaiter`. It
  registers the waiter **synchronously** (preserving the register-then-release-
  lock ordering the park sites depend on), then races the waiter promise against
  a periodic **pty-liveness probe** (terminal-server session list, matched to the
  resolver's worktree cwd) plus an absolute wall-clock cap. Returns
  `'signalled'` (real completion) | `'resolver-dead'` (probe saw no live pty for
  N consecutive polls) | `'timeout'` (cap hit while liveness stayed "can't
  tell"). On a non-signalled release it `abandon`s the registry entry. Config +
  `listSessions`/timer deps are injectable for tests; production defaults ~75s to
  detect a dead pty, 30-min hard cap. This is why a dead resolver can no longer
  wedge the run + hold the project lock forever.
- `abandonedResolver.ts` — `recoverAbandonedResolverTask(task)`: the shared
  "resolution is being abandoned" cleanup — abort a lingering in-worktree merge,
  clear the conflict flags (makes a late /merged a no-op), kill the resolver pty
  by cwd. Called by both `routes/tasks/hooks/mergeAborted.ts` (give-up resolver /
  Cancel) and the `waiterLiveness.ts` dead/timeout path. Leaves the task at plain
  ready_to_merge to retry on the next merge-all.
- `state.ts` — stable public facade and `RunState` / `MergeRunStateManager`:
  persistent run maps, notify/subscribe fan-out, active-run lookup/cancel, and
  delegation to snapshot/normalization/waiter helpers. Two rules keep the
  "one active run per project" gate from turning into a permanent wedge:
  - **The in-memory run object is authoritative; `loadProject` may only ADD
    ids it doesn't already have.** The persisted cache holds *snapshots*
    (`syncProjectFromRunMap` clones on the way out), so re-seeding an existing
    id swapped the LIVE object the worker mutates for a frozen clone. A second
    `startMergeRun` landing mid-run — a resolver `/complete` restart
    (`routes/tasks/finalizeResolved.ts`), a workflow Merge control step, a UI
    click, all of which call `loadProject` *before* the 409 gate rejects them —
    then left the map holding a `status: 'running', processed: 0` clone forever
    while the real worker finished invisibly. Symptom (interview_eci,
    2026-08-24): every later merge-all 409s with "A merge run is already in
    progress" and the cancel button does nothing, until the backend restarts.
  - **A `running` record with no worker behind it is reaped, never obeyed.**
    `markRunLive`/`markRunSettled` (called by `startMergeRun` and its finalize)
    record which runs this process is actually executing; `reapOrphanedRuns`
    (run from `initializeRunState` and `getActiveRunForProject`) errors out any
    other `running` record for the project, and `cancelRun` settles one outright
    instead of setting a flag nothing will ever read. This is the backstop for
    the whole class — whatever leaves a zombie record behind, it costs one
    reaped run, not every future merge for that project.
- `preflight.ts` — per-run setup: task JSON backup, git bundle backup,
  Lattice-owned exclude/untrack repair, copy snapshot, and baseline HEAD for
  the circuit breaker.
- `processTarget.ts` — per-task state machine: re-read task state, honor the
  merge lock, retry flagged conflicts, re-sync/finalize, spawn resolver PTYs,
  update run progress, and run the repo-integrity check.
- `flaggedConflict.ts` — `handleFlaggedConflictTask`: a retried `conflict:true`
  task. Still mid-merge (worktree has markers) → `tryRespawnMidMergeResolver`
  re-spawns a resolver and parks the run on its waiter; worktree already clean →
  `tryFinalizeAfterResolverFinished` re-syncs + finalizes directly when main is
  already an ancestor, else falls through to the normal merge path.
- `repoIntegrity.ts` — the run **circuit breaker** (`checkRepoIntegrity` /
  `finishTaskAndCheckIntegrity`): between tasks verify `.git` still exists and
  HEAD only moved *forward* (FF). On a violation it records a `(run)` error,
  sets `cancelRequested`, and halts so the remaining `ready_to_merge` tasks stay
  put rather than piling onto a damaged repo.
- `resolverSpawn.ts` + `resolverSpawn/` — conflict-resolver spawn subsystem
  (`resolverSpawn.ts` is the re-export facade; existing `./resolverSpawn.js`
  imports keep working). Split by concern so the spawn *mechanics* stay
  separate from the *policy* that drives them:
  - `resolverSpawn/park.ts` — `parkOnConflictResolver`: awaits the conflict
    waiter (via `waiterLiveness.ts` `awaitResolverWaiter`, so the wait is
    bounded) then **drops the per-task merge lock before waiting** (the
    resolver's `/complete` finalize needs that same lock — see its deadlock
    note). The lock-release semantics live here; returns the `WaiterReleaseReason`
    so `handleOutcome.ts` can recover-and-continue on a dead/timed-out resolver.
  - `resolverSpawn/spawn.ts` — terminal-session spawn/notify/record mechanics:
    `queuedCreateSession` on the `priority` band (headroom above softCap),
    conflict notification, `spawnAndRecord`/`recordAndSpawn` (which own the
    `run.conflicted` array update — successful spawn only), and
    `respawnResolverForFlaggedConflict`.
  - `resolverSpawn/handleOutcome.ts` — `handleResyncOutcome`: the higher-level
    policy deciding, per `ResyncOutcome`, whether to finalize (push
    `run.merged`), park on a resolver, cancel the run after a stash conflict,
    or record a `run.errored` entry.
- `withMergeLock.ts` — shared per-task merge-lock lifecycle used by
  `processTarget` and `flaggedConflict`'s `tryFinalizeAfterResolverFinished`:
  `tryAcquire`, record the "lock held" error and report `lock-unavailable` on
  failure, else run the work under a try/finally that releases the lock unless
  the work handed it off early (an `awaiting-resolver` outcome parks on the
  conflict waiter, which releases the lock itself). Callers decide the
  lock-unavailable follow-up (skip vs. errored-outcome), so the helper only
  reports it.
- `lifecycle.ts` — run-startup helpers: `initializeRunState` (canonicalize +
  load + in-process active-run/409 gate + cross-process lock acquire, honoring
  `lockMode: 'inherit'`), `filterAndSortTargets` (ready_to_merge incl.
  conflict-flagged, createdAt-ascending — the ordering invariant), and
  `createRunRecord`. Throwing in `initializeRunState` happens before any run
  record exists.
- `teardown.ts` — post-run teardown: `runTeardown` (copy-snapshot restore
  in-session, **on cancel too** — deferring a cancelled run's snapshot to the
  next boot let a user's re-done edits be clobbered, so it restores now while
  the tree is untouched; then `autoRestartIfNeeded`), `autoRestartIfNeeded`
  (**returns** whether a fresh run is needed for tasks that became ready mid-run
  — skipped when the lock was inherited), and `runPostMergeHook` (the
  once-per-run hook gate). Teardown only *decides* the restart; it no longer
  fires it. The decision is a plain boolean, so teardown keeps no runtime
  dependency back on `../mergeRuns.ts`.
- `finalize.ts` — `finalizeMergeRun`: runs the worker `body` (preflight + loop +
  teardown + hook + finishRun), releases the project lock in a `finally`, and
  **then** auto-restarts iff `body` returned `true`. The restart MUST happen
  after the lock release and after finishRun has flipped status off 'running';
  otherwise the fresh run's in-process 409 gate / cross-process lock reject it
  and `restartMergeRun`'s `.catch(() => {})` swallows the throw, stranding the
  mid-run-ready tasks at ready_to_merge (no stale lock ⇒ no boot resume either).
  A worker crash suppresses the restart.

Conflict-waiter contract: after spawning a merge-conflict resolver,
`processTarget` registers a task-id keyed waiter. Routes `/complete`, `/merged`,
**and `/merge-aborted`** call `signalConflictWaiter` — the first two only after
finalize/re-sync has advanced or requeued that same task, `/merge-aborted` after
clearing the conflict (a give-up resolver / Cancel — the task stays at plain
ready_to_merge and is NOT auto-restarted). `cancelRun` unblocks the waiter whose
entry belongs to the cancelled run. A missing waiter means the backend
restarted, so the caller should start a fresh merge run.

The worker parks on that waiter via `resolverSpawn.ts` `parkOnConflictResolver`,
which **drops the per-task `mergeLocks` lock before waiting** (registering the
waiter first — the entry is recorded synchronously, so a racing signal can't be
missed). It must: the signal comes from the resolver's `/complete` →
`finalizeResolvedTask`, which takes that same per-task lock to re-sync + FF main
+ signal. Holding the lock across the park makes that finalize lose `tryAcquire`,
return `already-finalizing` without signalling, and the run hangs forever (with
the resolver pty stranded — only the finalize's worktree cleanup kills it). The
mid-merge re-spawn waiter (`flaggedConflict.ts` `tryRespawnMidMergeResolver`)
parks before any lock is acquired, so it is already lock-free.

Bounded lifetime (why the run can't wedge on a silently-dead resolver): both
park sites await `waiterLiveness.ts` `awaitResolverWaiter` rather than the raw
`registerConflictWaiter`. `/merge-aborted` covers only the *graceful* give-up
(the resolver aborts + curls a callback); a resolver that dies with NO callback
— crash, OOM, user kills the pty, missed Stop hook — is caught by the liveness
probe. On `'resolver-dead'`/`'timeout'` the park caller logs, records a
`run.errored` entry, `recoverAbandonedResolverTask`s the task (conflict cleared,
left at ready_to_merge), and continues — so `finalizeMergeRun`'s `finally`
always reaches `releaseLock` and the project run-lock is freed. The lock was
already released inside `parkOnConflictResolver` before the wait, so the
merge-conflict outcome stays `'awaiting-resolver'` (don't double-release)
regardless of how the wait ended.

2026-09 recovery/teardown corrections:

- A flagged mid-merge task first probes the detached terminal server. An agent
  command containing `MERGE_INSTRUCTIONS.md` in the exact normalized worktree
  cwd is reattached; unknown liveness fails the attempt safely, and only a
  confirmed absence spawns another resolver. A normal task agent or shell must
  not be adopted as a resolver.
- The task waiter is registered before probing/repairing the recovered session,
  then passed into the liveness wrapper; a callback during those awaits is kept.
- `loadRunTargets` releases an acquired project lock if startup task loading
  throws before the worker exists. The worker runs snapshot teardown in a
  `finally` around its task loop, including unexpected task/read failures.
