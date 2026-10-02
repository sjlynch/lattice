# backend/src/workflowRuns/controlSteps

The per-kind workers for `start` / `merge` / `push` provide **backend
orchestration** of Lattice's task pipeline: Start launches task agents, Merge
drives merge runs that may involve resolver / post-merge sessions, and Push
launches a harness session with the `workflow-push` brief (see
[pushRuns](../../pushRuns/CLAUDE.md)). `../controlStep.ts` is the thin dispatcher
(lock lifecycle + kind→worker routing); each worker lives here. This control
dispatch is distinct from authored `agent` planning steps that file tasks and
the fixed-brief Run tests path. Read the timing/lock invariants below before
touching these workers.

Backend command references (cwd `backend/`): `npm run build`, `npm test`,
`npx tsc --noEmit`.

## Lane-transition map

| Step | Drains (waits until empty) | Fills / advances |
|------|----------------------------|------------------|
| `start` | — (reads the **Open** lane) | Open → In Progress (spawns each) |
| `merge` | The run's round (its queued/in-flight runs and In Progress tasks) before **any** merge, then Ready-to-Merge, then the post-merge hook (Phase C) and a final task re-check | Ready-to-Merge → QA (via inner merge runs) |
| `push`  | Ready-to-Merge | pushes `main`'s existing commits to the remote (no lane change, no commit) |

The Run tests step (`test`) uses the agent-step path to spawn a fixed-brief
agent ([testStep](../testStep/CLAUDE.md)), outside the control dispatcher. It
holds the same per-project run-lock, as `workflow-test:<runId>` (non-lendable),
for its whole duration and releases it before the next step (typically Push)
dispatches.

## Cross-process project run-lock (the load-bearing invariant)

`controlStep.ts` acquires the per-project run-lock
(`~/.lattice/per-project/<hash>/run.lock`, `label: workflow-<kind>:<runId>`)
for the worker and **releases it in its `finally`** — even on throw — *before*
calling `completeStep`. While it's held, `scripts/dev.mjs` defers backend
restarts and a manual `/merge` can't race the workflow.

**Every wait inside a control step MUST be bounded.** If a worker blocks
forever, its `finally` never runs, the lock is held forever, and *all* future
merge runs / control steps for that project are blocked (and dev.mjs keeps
deferring restarts). This is why `waitForLaneEmpty` (below) and the push
session wait both have timeouts. `runControlStepWorker` takes injectable deps
(`acquireLock` + the three runners) so the release-on-throw path is unit-tested
(`__tests__/workflowLaneWaitTimeout.test.ts`).

## `shared.ts` — task waits / `emitControlProgress`

The waits live in their own files; `shared.ts` re-exports every name below.

- `laneWait.ts` — `waitForLaneEmpty` + `LaneWaitDeps`.
- `mergeWorkWait.ts` — `waitForMergeWork` + `MergeWorkWaitDeps`; poll interval and per-task phases are named constants.
- `postMergeHookWait.ts` — `waitForPostMergeHookIdle` + `PostMergeHookWaitDeps`.
- `waitPrimitives.ts` — import-cycle-free leaf: `isRunEndedEvent`, `createWaitSettler` (settle-once finish/fail + cleanup), `createUnrefTimer` (re-armable no-progress timer).

`waitForMergeWork(project, run, onProgress, maxWaitMs, deps?)` resolves with a
task snapshot once **no task in the run's round** is admitted or running, so
the round merges together (do not regress: it used to wake on the first
ready task and merge it while its siblings still ran). The round is
`WorkflowRun.roundTaskIds` — tasks Open or In Progress at run start plus
everything the Start step launched or queued; a legacy run without one counts
every task. Pending means `in_progress`, persisted `runQueued`, or a live
`task-run:<id>` request (pending or in flight). Tasks outside the round, and
ordinary Open/Backlog tasks without either admission marker, do not block.
**One early wake (deadlock guard):** when ready work exists and *every*
pending round task is a queued start held for disk (`runWaitingForDisk`), it
resolves anyway — `diskPressureMerge` leaves projects with an active workflow
alone, so only this step's merge can free those worktrees. It subscribes before reading and polls as a
fallback because queue settlement itself has no task-store notification (a
failed spawn clears its flag before its live request disappears). Newer store
events supersede an outstanding read. Cancellation resolves promptly; errors
and the no-progress timeout reject and clean up all subscriptions and timers.
The deadline re-arms on forward per-task transitions, including queued →
running even with unchanged counts; metadata updates cannot extend it.

`waitForLaneEmpty(project, run, laneStatus, onProgress, maxWaitMs?, deps?)` —
the lane-drain used by push:

- Resolves when the lane count hits **0** OR the run leaves `'running'`
  (cancellation). Subscribes to the task store **before** the initial
  `listTasks` read so a transition in the gap isn't missed; also subscribes to
  workflow-run events so a cancel resolves it promptly.
- **Bounded wait (`maxWaitMs`) — a NO-PROGRESS timeout, not a total one.** The
  deadline is re-armed every time a task leaves the lane, so it trips only after
  `maxWaitMs` with **no drain at all**. A lane can legitimately never empty — a
  task whose agent died without committing is refused auto-completion by the
  in-progress sweep (`recovery/inProgressSweep/eligibility.ts`, `no-commits` →
  skip) — and that genuinely-stalled case still **rejects** so the worker's catch
  errors the run and releases the run-lock (an unbounded wait would leak it). But
  a lane that keeps draining, however slowly and however long in total, must
  never trip: a *total* cap here fired ~5s before the last of 29 codex tasks
  finished and stranded the whole batch at ready_to_merge (Phase B never ran).
  Push passes `PUSH_DRAIN_TIMEOUT_MS` (15 min). Merge now uses the combined
  waiter above with `TASK_DRAIN_TIMEOUT_MS` (30 min); both measure time with zero
  progress. Covered by `__tests__/workflowLaneWaitTimeout.test.ts`. `deps` is
  injectable only for the tests.
- Task-read and progress-callback failures reject the lane waiter and release
  its subscriptions; they must never become detached promise rejections that
  kill the backend through `processGuards`. The no-progress timeout also covers
  an initial task read that never settles.

`waitForPostMergeHookIdle(project, run, onActive, maxWaitMs?, deps?)` — the
merge step's **Phase C** gate. Resolves when no post-merge hook is `running` for
the project (or the run is cancelled); bounded, so a hook agent that dies
without calling `/complete` can't leak the run-lock. Same subscribe-before-read
race guard as `waitForLaneEmpty`. It also waits through the trigger's
pre-record settings-read marker and keeps its initial idle subscription alive
for one event-loop turn, closing the task-QA-notify → hook-record gap. Its
subscriber is deliberately **not**
filtered by project — `getActiveHookForProject` canonicalizes the path it
compares while `ev.run.projectPath` is the raw string the trigger was handed, so
a `!==` filter would drop our own project's events; re-evaluate on every (rare)
hook event and let the canonicalizing lookup decide.

`emitControlProgress` is the single shaper for the `step-control-progress` WS
event so every worker reports progress identically (agent steps' pre-run-tool
note in `../stepSpawner.ts` and the Run tests step's `progress` use it too).

`isRunEndedEvent(ev, runId)` — the "this workflow run was cancelled/errored"
filter every wait resolves on. `subscribeOnce(install, onSettle)` — the
subscribe-before-check, settle-once idiom (unsubscribes even when the listener
fires synchronously during subscription); used by `raceWorkflowRunEnd` and
`waitForMergeRunFinished`.

## `start.ts` — `runStartStep`

Moves every Open task to In Progress and runs it (the Task Board **Run All**
path), emitting one `workflow-task-spawned` terminal tab per task.

- **Round membership**: every Open task it handles (started, queued or left to
  an existing queued run) is added to `WorkflowRun.roundTaskIds` and
  checkpointed **before the first launch**, so a restart cannot forget a
  running member and let Merge merge around it.

- **Harness/Pi-model picker** mirrors Run All via
  `resolveStartStepHarnessPicker` (`startHarness.ts`, re-exported from
  `start.ts`): a run-level `harnessOverride` pins every task
  (Pi override carries its `piModelOverride`); with no override the per-project
  default applies (`interleave` expands to the same alternating claude/pi mix).
- **Hard-cap handling (do not regress)**: each spawn passes
  `throwOnCapacity: true`. When the terminal-server hard cap rejects a spawn
  (`SpawnCapacityError`), `startTaskById` throws **before** flipping the task to
  in_progress, so the task stays **Open** (no phantom in_progress-without-agent,
  no orphan pty). The step then re-queues it via `enqueueTaskRun` (the spawn
  queue, so it starts when a slot frees) and counts it as **neither started nor
  failed** — a cap deferral is forward progress. Without `throwOnCapacity` the
  cap was swallowed: the task was force-flipped to in_progress with no agent and
  counted as started, leaving excess tasks stuck forever and manufacturing the
  stuck lane that hangs the Merge step. The "started 0 → throw" guard fires only
  when *nothing* started *and nothing* was cap-deferred. Covered by
  `__tests__/workflowStartStepCap.test.ts`.
- **Queue admission (do not regress)**: the step starts tasks directly, which
  bypasses the spawn queue — and with it `maxConcurrentAgents` and the CPU/RAM
  resource governor (a 50-task Start step launched 50 agents at once). Before
  each start it asks `batchAdmissionHold()` (fresh `/sessions` poll + governor
  sample); when the queue would hold a batch spawn, the task is handed to
  `enqueueTaskRun` and counted as deferred — the same path a cap rejection
  takes — so it starts as soon as capacity returns. A disk-space deferral
  (`SpawnDiskSpaceError`, `isSpawnDeferral`) is handled the same way.
- **Only successful admission counts as deferred.** Both requeue paths return
  a per-task failed outcome if enqueue rejects, preserving the enqueue error
  for the all-failed guard. Later tasks still get their chance; partial success
  advances, but zero started/queued tasks rejects. A known queued run remains
  deferred without another enqueue, including while admission is held.
- **Cancellation owns only pending direct launches.** Start re-checks the run
  status and current step after task reads, harness selection and admission
  polls, before enqueue/requeue, and before publishing spawn/progress events.
  Each direct `startTaskById` gets an AbortSignal subscribed to workflow end or
  advance; its existing withdrawal checkpoints reclaim an unestablished
  checkout/PTY. The subscription and CAP checkout parking are released in
  `finally`. Established agents and accepted queue requests keep their task
  lifecycle; never cancel a shared `task-run:` key to stop the workflow.
  Deferred-promise coverage: `__tests__/workflowStartStepCancel.test.ts`.
- **Never start a task the queue is already starting (do not regress)**: a
  queued run (Run All, a manual ▶, boot re-enqueue) keeps its task `open` until
  the pty spawns — minutes on a big repo waiting on the checkout gate — so it
  still passes `startTaskById`'s freshly-runnable check. Starting it again made
  the second setup's reconcile kill the first run's pty and force-remove its
  worktree, or (first agent already committed) take a `-r2` path with two live
  agents on one task. A task with `runQueued` or a live `task-run:<id>` queue
  request (`hasSpawnRequest`, checked after the admission-hold await), or a
  `startTaskById` already in flight (`isTaskStartInFlight`), is skipped and
  counted as deferred. Covered by `__tests__/workflowStartStepCap.test.ts`.
  The reverse race — a `/run` admitted while this step's own start waits on
  the checkout gate — is serialized inside `startTaskById` (the later start
  waits, then withdraws; see `routes/tasks/CLAUDE.md`).

## `merge.ts` — `runMergeStep`

`drainReadyToMerge` waits on `waitForMergeWork` before **every** merge round,
so a zero-count In Progress gap or a task spawning during a merge cannot end
the step prematurely. It merges nothing while a round task is still queued or
running, except for the disk-held early wake above: `diskPressureMerge` refuses
a separate merge during a workflow, so this inherited-lock merge must be able
to free disk for deferred starts, and the next loop iteration then waits for
the starts it unblocked. Ready tasks outside the round merge along with it.
It loops merge runs (`lockMode: 'inherit'` so they don't deadlock on the lock
this worker holds), with an **id-set progress guard**: it aborts the
moment a full merge run leaves the ready_to_merge id-set unchanged (a
persistently-erroring task is left in the lane by `processTarget`, so comparing
the lane before/after — not the error *count* — is what stops the infinite
loop). Covered by `__tests__/workflowMergeStepLoop.test.ts`; its abort message
is built by `noProgressError`. After Phase C it re-checks the combined task
condition; newly observed work returns to the drain and then the hook gate
after the actual final merge. Queued lifecycle, disk progress, cancellation,
timeout and lock-release coverage: `__tests__/workflowMergeQueuedRuns.test.ts`.

**Phase C — the post-merge hook gate (do not regress).** The step must not
report `merge complete` while a post-merge hook is running for the project, or
the workflow run finishes and the frontend queue starts the NEXT workflow's step
1 on top of the live hook agent. It is *not* enough that Phase B awaits its merge
runs:

- A hook fired **by a merge run** is already gated — `mergeRuns.ts` awaits
  `runPostMergeHook` *before* `finishRun`, so `waitForMergeRunFinished` waits it
  out transitively. Keep that ordering.
- A hook fired **outside a run** is not. `awaitPostMergeHookOutsideRun`
  (`routes/tasks/hooks/`: the resolver `/complete` branch, `/merged`,
  `/stash-resolved`) skips when a merge run is active — i.e. it fires *precisely*
  when no `finishRun` will gate it. `/stash-resolved` does so by design when its
  auto-restarted run picks up no work.

The queue can't close this itself: its only sequential gate,
`assertNoActiveWorkflowRun`, counts **workflow runs, not hooks**. Making
a run start 409 on a live hook would also stall the queue — its 409
retry is driven by `runFinished` (a workflow run leaving `activeRuns`), and a
hook finishing emits no such event. So the wait belongs here, where the step
already owns "all merging for this workflow is done" and the wait is bounded.
Covered by `__tests__/workflowMergeStepPostMergeHook.test.ts`.

## `push.ts` — `runPushStep`

Drains Ready-to-Merge, then spawns a push session (Task Board cloud-icon path)
and waits for its `/done` completion callback. `runPushStep` is a short sequence
over two local helpers: `adoptOrDrain` (the completed-run / live-session
re-dispatch short-circuits, else the drain) and `createPushSessionWatch` (owns the session
ids, the `cancelled` / `timedOut` flags, the `done` promise, both subscribers,
the timeout, admission AbortController and the single `killAndAbandon()`;
disposed in the `finally`).

- **Harness/model selection**: forwards `effectiveStepHarness` and
  `effectiveStepPiModel` to the push session, just as agent and Run tests steps
  do. The run override wins over the step's own selection. Completion hooks,
  command construction, presence and recovery follow that harness.

- **Push-only brief (R2)**: the step calls
  `startPushSession(project, origin, { brief: 'workflow' })`, which renders the
  `workflow-push` instruction template instead of the QA-lane button's `push`
  one: `cd`, `git status` (uncommitted / untracked files are left untouched and
  listed in the report), `git push` (`git push -u origin HEAD` when there is no
  upstream), a one-line report. No `git add` / `git commit` — a workflow runs
  unattended on the main checkout, where uncommitted files are the user's own
  work in progress. Everything a workflow produced is already committed (task
  branches, the merge's fast-forward, Run tests' fix commits).

- **Subscribe before spawn**: the push-run `done` and workflow-run
  `cancelled/errored` subscribers are attached *before* `startPushSession`, so a
  fast `done` / a cancel can't slip past (`createPushSessionWatch` runs before
  the spawn). `sessionServerId` is unknown until `startPushSession` resolves —
  the watch captures it by closure via `attach(session)`.
- **`PUSH_STEP_TIMEOUT_MS` (15 min)** backstop: if the selected harness exits or
  stalls without its `/done` completion callback landing, the wait would
  otherwise hang forever — the timer kills the pty, settles the push run
  (`abandonPushRun`) and the step **throws**
  `push step timed out after 15 minutes`, so `controlStep.ts` **errors the
  run** (it used to report `'push complete'` and advance as if the push had
  landed). A push whose own `/done` already landed is not a timeout, and a user
  cancel (or an `errored` run) that lands first keeps its state — the timeout
  never turns a cancel into `errored`. `PushStepDeps.pushTimeoutMs` overrides
  the bound for tests (`__tests__/workflowPushStepCancel.test.ts`).
- **`step-spawned` carries the registry `terminalId`** (from the spawn, or
  `findTerminalId` by `serverId` for an adopted session). The push tab closes
  when `/done`'s scratch cleanup kills the pty (`owner-finished`), and that
  close matches only the registry record's tab; without the id the frontend
  minted a separate unregistered tab that never closed.
- **The step forgets its push run** (`forgetPushRun` in its `finally`). The
  Task Board's push is forgotten by its UI poller's DELETE; nothing polls a
  workflow push, so without this every one stayed in the registry for the life
  of the process. The registry never forgets a still-`running` run.
- **Cancel/admission race (do not regress)**: the watch owns an AbortController
  passed through `startPushSession` and the homeScratch adapters to
  `queuedCreateSession`. Cancellation and timeout withdraw a pending request,
  so startup settles and scratch cleanup completes without capacity returning.
  If PTY creation already started, startup waits for its response and confirmed
  reclamation before rejecting; never race and abandon the startup promise.
  Cancellation remains cancelled; a timeout rejects with the push timeout
  message so the worker errors the run and releases its lock without advancing.
  The **post-spawn re-check** remains necessary for cancellation after admission
  delivered the PTY but before `attach`: it awaits the kill and emits neither
  `step-spawned` nor `'push complete'`. Covered by
  `__tests__/workflowPushStepCancel.test.ts`.
- **Re-dispatch attaches, never double-pushes.** A backend restart kills the
  step (it is re-dispatched by `recovery/workflowRunResume.ts`) but not its
  push session, which lives in the detached terminal-server. The session is
  spawned with `workflow: {runId, stepIndex}`, recorded on the persisted push
  run; boot recovery re-adopts it, and the re-dispatched step's
  `findLivePushSession` (→ `findRunningPushRunForWorkflowStep`) returns it, so
  the step skips the drain, surfaces that pty in `step-spawned`, and waits for
  ITS `/done` (fresh timeout) instead of starting a second push. A push whose
  pty boot recovery already found gone is flagged `lost` and never attached
  (the step pushes afresh); an attached one settled `lost` later fails the
  step ("push session terminal exited without reporting completion"). Covered
  by `__tests__/oneOffRunResume.test.ts`.
