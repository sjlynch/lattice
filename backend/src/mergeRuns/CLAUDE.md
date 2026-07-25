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
  task, and task-id signalling prevents task A from unblocking task B.
- `state.ts` — stable public facade and `RunState` / `MergeRunStateManager`:
  persistent run maps, notify/subscribe fan-out, active-run lookup/cancel, and
  delegation to snapshot/normalization/waiter helpers.
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
  - `resolverSpawn/park.ts` — `parkOnConflictResolver`: registers the conflict
    waiter then **drops the per-task merge lock before waiting** (the
    resolver's `/complete` finalize needs that same lock — see its deadlock
    note). The lock-release semantics live here.
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
`processTarget` registers a task-id keyed waiter. Routes `/complete` and
`/merged` call `signalConflictWaiter` only after finalize/re-sync has advanced
or requeued that same task; `cancelRun` unblocks the waiter whose entry belongs
to the cancelled run. A missing waiter means the backend restarted, so the
caller should start a fresh merge run.

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
