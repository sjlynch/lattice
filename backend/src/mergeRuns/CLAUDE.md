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
- `lifecycle.ts` — run-startup helpers: `initializeRunState` (canonicalize +
  load + in-process active-run/409 gate + cross-process lock acquire, honoring
  `lockMode: 'inherit'`), `filterAndSortTargets` (ready_to_merge incl.
  conflict-flagged, createdAt-ascending — the ordering invariant), and
  `createRunRecord`. Throwing in `initializeRunState` happens before any run
  record exists.
- `teardown.ts` — post-run teardown: `runTeardown` (copy-snapshot restore on a
  non-cancelled run, then `autoRestartIfNeeded`), `autoRestartIfNeeded`
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
