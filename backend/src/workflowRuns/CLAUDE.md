# backend/src/workflowRuns

Workflow-step runner. The parent `workflowRuns.ts` is a thin orchestration
facade (start / cancel / advance / `dispatchStep`) over these modules.
Agent-step advancement is driven by Stop-hook / `session_shutdown` /
explicit-curl callbacks, never by task-state polling. Control workers
reconcile/wait on board state using subscriptions and polling fallbacks, then
call `completeWorkflowStep` themselves.

## Modules

**Run registry / state**
- `state.ts` — `WorkflowRun` / `WorkflowRunEvent`, the in-memory `runs` map,
  `notify` / `subscribe` / `getRun` / `getActiveRunsForProject`. The single
  source of every `/ws/workflow-runs` payload — keep event discriminants and
  field shapes (esp. `step-spawned`) stable. Finished runs are pruned to
  `MAX_FINISHED_RUNS_PER_PROJECT` (a memory bound); running runs never are.
  Also `isRoundTask` / `addRoundTasks` over `WorkflowRun.roundTaskIds`.
- `definition.ts` — `cloneWorkflowDefinition` / `readWorkflowDefinition`: the
  frozen per-run definition copy and its validated read-back.
- `frozenSteps.ts` — legacy pure frozen-step policy (`isStepFrozen`,
  `nextRunnableStepIndex`).
- `execution.ts` — current group policy and member state helpers. Adjacent
  `agent` steps with `parallel: true` form a group; all other steps are
  singletons. Form authored boundaries before skipping frozen members.
- `teardown.ts` — shared cancellation/error cleanup for every active member.
- `failRun.ts` — `failWorkflowRun` (re-exported by the facade), so `dispatch.ts`
  / `advance.ts` can error a run without importing the facade.

**Step dispatch / spawning** (agent steps)
- `dispatch.ts` — `dispatchStep` (kind → spawner / Run tests / control-step
  executor) and `dispatchGroup` (every active member; a setup failure errors
  the run). Takes `completeWorkflowStep` as a parameter, never importing
  `advance.ts`.
- `stepSpawner.ts` — `spawnWorkflowStep`, split into `prepareStepScratch` →
  `writeStepAssets` → `installStepCallbacks` → `spawnStepSession`. Writes the
  step dir (`<project>/.lattice/workflow-steps/<runId>/step-<N>/`) and installs
  all three completion callbacks (Claude Stop hook, Pi extension, Codex
  `hooks.json`). `opts.runTests` is the Run tests variant (see `testStep/`).
  Re-exports `writeScratchReadme` / `pruneOldWorkflowRuns` / `workflowStepAgentId`.
- `stepMarkdown.ts` — `renderStepMarkdown` (WORKFLOW_STEP.md),
  `effectiveStepHarness`, `renderStepCompletionInstructions`.
- `stepTools.ts` — pre-run tools (`WorkflowStep.tools`, v1 `opengrep`):
  `runStepTools` writes `OPENGREP_FINDINGS.md` + the `{{tool_reports}}` block;
  `beginStepPreRun` / `endStepPreRun` / `abortStepPreRun` make a cancel abort
  every member's scan. Controllers are keyed by run/member; Opengrep scans
  serialize per project so sibling scans do not collide with the one-scan slot.
- `projectDirtyState.ts` — `getProjectDirtyState` + `renderDirtyStateWarning`:
  the dirty-checkout banner at the top of WORKFLOW_STEP.md (best-effort).
- `commandBuilder.ts` — `buildWorkflowStepCommand` (harness dispatch via
  `../agentCommandBuilder.ts`).
- `sessionSpawner.ts` — `enqueueWorkflowStepSession` (spawn queue, presence
  node, `step-spawned` fan-out), `killWorkflowStepSession` /
  `releaseWorkflowStepSession` (advance; the latter with
  `keepWorkflowStepTerminals`), `cancelWorkflowStepSessions`.
- `renderHelperScript.ts` + `create-task-template.cjs` — the per-step
  `create-task.cjs` helper (create + `--summary` / `--list` / `--find` /
  `--get`; a dash-leading first arg is refused). The `.cjs` is a runtime asset
  copied by `scripts/copy-assets.mjs`. Tests: `createTaskHelper.test.ts`.
- `scratchDirectory.ts` — `writeScratchReadme`, `pruneOldWorkflowRuns` (keeps
  `WORKFLOW_RUN_RETENTION` runs plus every running one; path- and
  reparse-point-bounded delete).

**Completion / advance**
- `stopHookGate.ts` — the Claude Stop-hook **quiescence gate**
  (`requestStopHookStepComplete`, `recordStopReceived`, `cancelStopHookGate`),
  fed by `../agentQuiescence.ts`. See the invariant below.
- `advance.ts` — the advance engine, re-exported by the facade:
  `completeWorkflowStep` / `workflowStepCompletionAdvance`, the in-flight
  `completions` join, member settlement + group join, `completeRun`; dispatches
  the next group via `dispatch.ts`. The route is `routes/workflows/`.

**Persistence / recovery**
- `persistence.ts` — the `~/.lattice/per-project/<hash>/workflow-runs.json`
  mirror of running runs (atomic, debounced, never throws; absent when idle).
- `resumeDecision.ts` — pure boot policy `classifyWorkflowRunResume` →
  `readopt` / `redispatch` / `error` / `advance` / `skip`, plus
  `findStepSessionId`. The IO side is `../recovery/workflowRunResume.ts`.
- `recoveryReadiness.ts` — gates HTTP lifecycle requests and the
  `/ws/workflow-runs` hello until recovery has re-registered the runs
  (`isWorkflowRecoveryDone` / `whenWorkflowRecoveryDone`).

**Control steps** (`start` / `merge` / `push`)
- `controlStep.ts` — `executeControlStep`: lock lifecycle + kind → worker
  (`acquireControlStepLock` → kind runner → release → `settleControlStep`).
- `runErrored.ts` — `markRunErrored`: shared "error a running run" (status, finishedAt, error, notify, checkpoint); not `failWorkflowRun`.
- `controlSteps/` — the workers; Push runs through this engine while owning a
  push harness session. Read [`controlSteps/CLAUDE.md`](./controlSteps/CLAUDE.md).

**Run tests step** (`test`) — `testStep/`; read [`testStep/CLAUDE.md`](./testStep/CLAUDE.md).

## Adding a step-completion harness

1. Add the harness to `WorkflowStepHarness` (in `workflows.ts`).
2. Extend `buildWorkflowStepCommand` in `commandBuilder.ts` for the new
   command shape; put common harness syntax in `agentCommandBuilder.ts` if it
   is reusable outside workflow steps.
3. If the harness can't reliably curl the completion URL itself, install
   a callback shim alongside the Stop hook in `spawnWorkflowStep` (mirror
   `installPiCompletionExtension` for Pi's `session_shutdown` extension, or
   `installCodexStopHook` for Codex's `.codex/hooks.json` `Stop` hook — Codex
   has a Claude-style hooks framework whose `Stop` event fires once at turn
   completion; the injected hook curls `/complete?source=codex-stop-hook-*`,
   which the route advances immediately, same as the model's own curl).
4. Update `renderStepMarkdown` so the in-prompt completion instructions
   match (silent vs. explicit-curl).

## Invariants

**Starting**
- **One active run per project, always.** `startWorkflowRun` calls
  `assertNoActiveWorkflowRun` → `WorkflowRunConflictError` → **HTTP 409**
  `active-run-exists`, *before* any run record / notify / spawn (side-effect
  free). No opt-out; the old `requireNoActiveRun` body field is ignored. The
  frontend queue requeues on the 409. Only exception: boot recovery resumes
  every persisted run. The slot counts workflow runs, **not** post-merge hooks
  (the 409 retry only re-fires on a run finishing); hook exclusion is the merge
  step's Phase C (`controlSteps/CLAUDE.md`).
- New runs freeze their definition (incl. variables); editor changes never
  alter an executing or recovered run. Version-1 records without one use the
  legacy lookup.
- A workflow whose steps are *all* frozen is refused before any run record.
- **Every run records its task round** (`roundTaskIds`): tasks Open or In
  Progress at start (read *before* `assertNoActiveWorkflowRun`, so nothing
  awaits between the guard and `runs.set`), plus every task the Start step
  handles (checkpointed before its first launch). The Merge step waits for
  the whole round before merging any of it; see
  [`controlSteps/CLAUDE.md`](./controlSteps/CLAUDE.md) → `waitForMergeWork`.
  Persisted in the mirror; a run without one (persisted before rounds, or an
  unreadable value) counts every task.

**Advancing**
- Groups advance sequentially and member completion is **idempotent**:
  stale callbacks are ignored; duplicates join the run/member promise.
  Each member checkpoints `completing` before terminal handling, then
  `completed` inside a per-run join lock. Failed initial checkpoints restore
  the prior member phase so its callback can retry.
- The successor dispatches once, after **every** active member is durably
  completed and its terminal handling has settled. The next group is
  checkpointed `pending` before dispatch. `currentStepIndex` remains the first
  runnable member for compatibility; `activeStepIndices`, `groupEndIndex`, and
  `stepStates` drive new runs. Older records retain singleton behavior.
- Only planning `agent` steps can opt in. Start/Merge/Run tests/Push are always
  sequential barriers, including when frozen. A frozen unmarked agent also
  separates groups; a frozen marked member stays in its group but is skipped.
  Every runnable member enters the existing spawn queue and respects capacity.
- **Terminal handling precedes the next dispatch.** By default,
  `killWorkflowStepSession` awaits any outstanding allocation and the kill —
  `codex --yolo` never self-exits. With project `keepWorkflowStepTerminals`
  enabled, `releaseWorkflowStepSession` awaits allocation, drops spawn
  bookkeeping and deliberately leaves the PTY alive for inspection until its
  tab closes. (`workflowStepSpawnFailure.test.ts`.)
- **Claude Stop-hook completions are quiescence-gated**, never immediate: a
  `Stop` fires early/repeatedly while subagents run, and advancing on it ran
  steps in parallel. Only the `claude-stop-hook-*` source is gated; the explicit
  curl / Pi / Codex sources advance immediately, and control steps call
  `completeWorkflowStep` directly. The gate tracks subagents by `agent_id` (not
  a count), waits for a Stop *after* a subagent finishes (`awaitingTurnEnd`),
  counts **every** `wf:` / `pmh:` hook event as a signal, and requires
  `READOPTED_SETTLE_MS` of silence for a re-adopted session. A held Stop must
  survive a restart: the route awaits `recordStopReceived` before answering and
  recovery re-arms with `{ rearm: true }`: if the gate was busy at its last
  checkpoint (`stopReceived.busy`) the window counts from BOOT (downtime is not
  silence), else from the later of `stopReceived.at` / `.activeAt`; the boot
  placeholder signal never counts as busy. The post-merge hook mirrors this
  (`stopReceivedAt` / `stopActiveAt` / `stopBusy`). Failed completion checkpoints re-arm up to
  three times, then leave the run + terminal with a visible error (a Run tests
  step keeps retrying instead).
- The Claude Stop hook is installed for every step regardless of harness.

**Failure / cancellation**
- A rejected queued spawn for an ordinary planning step errors its still-current
  run (thrown setup / transport included). Run tests' `onSpawnError` adapter
  records `not-run` and advances; see [`testStep/CLAUDE.md`](./testStep/CLAUDE.md).
  CAP retries stay pending; a late rejection must preserve a cancellation or a
  newer step.
- Cancellation is authoritative and uses its separate kill path regardless of
  terminal retention: `cancelWorkflowRun` cancels pending
  `wf-step:<runId>:<step>` queue entries, unregisters the presence node, kills
  any tracked `serverId`, aborts a pre-run scan and a pending stop-hook gate;
  queued thunks re-check run status / active membership before and after
  `proxyCreateSession`. A tool that cannot run never fails its step.
- **A terminal transition checkpoints immediately** (`cancelWorkflowRun`,
  `failWorkflowRun`, `markWorkflowStepSpawnErrored`, control-step errors follow
  `notify` with `void checkpointWorkflowRun(run)`), since `notify` only
  schedules the 100 ms debounced mirror. Planning-step setup failures and
  advance failures after the initial completion checkpoint go through
  `failWorkflowRun`. An error landing after the run already left `running`
  keeps the existing terminal state.
- Control steps: the lock is released **before** `completeStep`, inside a
  restart-drain transition (`../restartDrain/`); the worker is detached, so
  every await it owns — `completeStep` included — is guarded (an unobserved
  rejection kills the backend via `processGuards`).

**Surviving a restart**
- **A run must survive the backend process.** `dev.mjs` defers restarts only
  while a `run.lock` is held (control + Run tests steps), so every agent step is
  exposed; a lost run silently drops its agent's later `/complete`. Keep the
  `persistence.ts` mirror current on every run mutation and `restoreWorkflowRun`
  idempotent (never clobber a live run). Restarts are also preceded by a drain:
  start / advance are tracked transitions, spawns wait `pending` in the held
  queue, and `POST /api/workflows/:id/run` answers 503 `backend-restarting`.
- Mirror writes and deletions are serialized per project; flushing awaits
  writes in flight (a late running-state write must not resurrect a finished
  run).
- Checkpoint phases `pending` / `spawning` / `running` / `completing`: required
  writes precede launch/teardown. A `pending` step (incl. one in its pre-run
  scan) is always re-dispatched; `spawning` with no terminal errors;
  `stepSessionAlive: null` ("can't probe") re-adopts; `completing` advances
  without replaying the prompt.
- Version-3 mirrors snapshot group state deeply at enqueue time. Recovery
  independently re-adopts, redispatches, or finishes each member and re-arms
  every held Stop gate. Completed members never replay; an all-completed group
  finishes its join. Invalid group state errors visibly rather than falling
  back to a serial replay. Tests: `workflowParallelSteps.test.ts`.
- During recovery, lifecycle requests wait (then 503 + Retry-After), unknown
  callbacks get 404 — never acknowledge an unknown run — and
  `/ws/workflow-runs` hellos carry `recovering: true` until an authoritative
  one follows.

Reference commands (cwd `backend/`): `npm run build`, `npm test`,
`npx tsc --noEmit`.
