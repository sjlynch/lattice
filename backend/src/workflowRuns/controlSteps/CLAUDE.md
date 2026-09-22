# backend/src/workflowRuns/controlSteps

The per-kind workers for **headless** workflow steps — `start` / `merge` /
`push` — that run server-side against Lattice's own task pipeline instead of
spawning an agent. `../controlStep.ts` is the thin dispatcher (lock lifecycle +
kind→worker routing); each worker lives here. These files hold subtle,
easy-to-break timing/lock invariants; read this before touching them.

## Lane-transition map

| Step | Drains (waits until empty) | Fills / advances |
|------|----------------------------|------------------|
| `start` | — (reads the **Open** lane) | Open → In Progress (spawns each) |
| `merge` | In Progress (Phase A), then Ready-to-Merge (Phase B loop), then the post-merge hook (Phase C) | Ready-to-Merge → QA (via inner merge runs) |
| `push`  | Ready-to-Merge | pushes `main` to the remote (no lane change) |

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

## `shared.ts` — `waitForLaneEmpty` / `emitControlProgress`

`waitForLaneEmpty(project, run, laneStatus, onProgress, maxWaitMs?, deps?)` —
the lane-drain used by both merge Phase A and push:

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
  Merge Phase A passes `PHASE_A_DRAIN_TIMEOUT_MS` (30 min); push passes
  `PUSH_DRAIN_TIMEOUT_MS` (15 min) — now both mean "30/15 min with zero
  progress". Covered by `__tests__/workflowLaneWaitTimeout.test.ts`. `deps` is
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
event so every worker reports progress identically.

## `start.ts` — `runStartStep`

Moves every Open task to In Progress and runs it (the Task Board **Run All**
path), emitting one `workflow-task-spawned` terminal tab per task.

- **Harness/Pi-model picker** mirrors Run All via
  `resolveStartStepHarnessPicker`: a run-level `harnessOverride` pins every task
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

## `merge.ts` — `runMergeStep`

Phase A drains In Progress (bounded, above). Phase B loops merge runs
(`lockMode: 'inherit'` so they don't deadlock on the lock this worker holds)
until Ready-to-Merge is empty, with an **id-set progress guard**: it aborts the
moment a full merge run leaves the ready_to_merge id-set unchanged (a
persistently-erroring task is left in the lane by `processTarget`, so comparing
the lane before/after — not the error *count* — is what stops the infinite
loop). Covered by `__tests__/workflowMergeStepLoop.test.ts`.

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
`requireNoActiveRun` 409 on a live hook would also stall the queue — its 409
retry is driven by `runFinished` (a workflow run leaving `activeRuns`), and a
hook finishing emits no such event. So the wait belongs here, where the step
already owns "all merging for this workflow is done" and the wait is bounded.
Covered by `__tests__/workflowMergeStepPostMergeHook.test.ts`.

## `push.ts` — `runPushStep`

Drains Ready-to-Merge, then spawns a push session (Task Board cloud-icon path)
and waits for its Stop hook.

- **Subscribe before spawn**: the push-run `done` and workflow-run
  `cancelled/errored` subscribers are attached *before* `startPushSession`, so a
  fast `done` / a cancel can't slip past. `sessionServerId` is unknown until
  `startPushSession` resolves — the subscriber captures it by closure.
- **`PUSH_STEP_TIMEOUT_MS` (15 min)** backstop: if Claude died before its Stop
  hook fired, the wait would otherwise hang forever — the timer kills the pty,
  settles the push run (`abandonPushRun`) and the step **throws**
  `push step timed out after 15 minutes`, so `controlStep.ts` **errors the
  run** (it used to report `'push complete'` and advance as if the push had
  landed). A push whose own `/done` already landed is not a timeout, and a user
  cancel (or an `errored` run) that lands first keeps its state — the timeout
  never turns a cancel into `errored`. `PushStepDeps.pushTimeoutMs` overrides
  the bound for tests (`__tests__/workflowPushStepCancel.test.ts`).
- **Cancel/spawn race (do not regress)**: cancelling the run *while*
  `startPushSession` is in flight runs the cancel handler with
  `sessionServerId` still `undefined`, so it kills nothing. A `cancelled` flag
  is set, and a **post-spawn re-check** (`cancelled || run.status !== 'running'`)
  kills the resolved `session.serverId` and returns without emitting
  `step-spawned` / `'push complete'` — otherwise a cancelled push still runs
  `git push` to completion and orphans the pty. Mirrors the existing post-spawn
  "already `done`" guard. Covered by `__tests__/workflowPushStepCancel.test.ts`.
