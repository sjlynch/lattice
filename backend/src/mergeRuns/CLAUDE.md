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

Conflict-waiter contract: after spawning a merge-conflict resolver,
`processTarget` registers a task-id keyed waiter. Routes `/complete` and
`/merged` call `signalConflictWaiter` only after finalize/re-sync has advanced
or requeued that same task; `cancelRun` unblocks the waiter whose entry belongs
to the cancelled run. A missing waiter means the backend restarted, so the
caller should start a fresh merge run.
