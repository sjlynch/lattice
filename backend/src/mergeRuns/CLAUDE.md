# backend/src/mergeRuns

Helper modules for the backend merge-all engine. `../mergeRuns.ts` owns the
public singleton API and worker loop; keep cross-module contracts documented
here instead of bloating the parent file.

- `state.ts` — `RunState` / `MergeRunStateManager`: persistent run records,
  `snapshot` / `notify` / `subscribe`, active-run lookup/cancel, and the
  task-id keyed conflict-waiter map.
- `preflight.ts` — per-run setup: task JSON backup, git bundle backup,
  Lattice-owned exclude/untrack repair, copy snapshot, and baseline HEAD for
  the circuit breaker.
- `processTarget.ts` — per-task state machine: re-read task state, honor the
  merge lock, retry flagged conflicts, re-sync/finalize, spawn resolver PTYs,
  update run progress, and run the repo-integrity check.

Conflict-waiter contract: after spawning a merge-conflict resolver,
`processTarget` registers a waiter. Routes `/complete` and `/merged` call
`signalConflictWaiter` only after finalize/re-sync has advanced or requeued
the task; `cancelRun` also unblocks it. A missing waiter means the backend
restarted, so the caller should start a fresh merge run.
