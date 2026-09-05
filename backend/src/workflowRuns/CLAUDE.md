# backend/src/workflowRuns

Workflow-step runner. The parent `workflowRuns.ts` is a thin orchestration
facade (start / cancel / advance) over these modules. Sequential
advancement is driven entirely by Stop-hook / `session_shutdown` /
explicit-curl callbacks — never by polling task state.

## Modules

- `state.ts` — `WorkflowRun` / `WorkflowRunEvent` types, the in-memory
  `runs` map, the listener set, and `snapshot` / `notify` / `subscribe` /
  `getRun` / `getActiveRunsForProject`. **The single source of truth for
  every payload that flows over `/ws/workflow-runs`** — preserve
  `WorkflowRunEvent` discriminants and field shapes (especially
  `step-spawned`) since the WS dispatcher and frontend consume them
  directly.
- `persistence.ts` — the on-disk mirror of every **running** run, at
  `~/.lattice/per-project/<hash>/workflow-runs.json` (home-scoped, atomic
  temp→rename, debounced, never throws). Written from `state.ts`'s `notify` for
  every run-carrying event plus an explicit call the moment
  `completeWorkflowStep` claims the next step index. Finished runs are dropped,
  so the file disappears when nothing is running. Exists because a run used to
  live only in memory — see the invariant below.
- `frozenSteps.ts` — the pure frozen-step policy: `isStepFrozen` +
  `nextRunnableStepIndex(steps, from)` (the first non-frozen step at or after
  `from`, or `null` when nothing runnable remains). The editor's snowflake
  toggle sets `WorkflowStep.frozen`; the step keeps its place and prompt but no
  run executes it. Consumed by the facade in exactly two places — the start
  index in `startWorkflowRun` and the advance in `completeWorkflowStep` — so
  keep the policy here rather than inlining it a third time. Covered by
  `__tests__/workflowFrozenSteps.test.ts`.
- `resumeDecision.ts` — the pure policy for re-adopting a persisted run:
  `classifyWorkflowRunResume` → `readopt` (agent step whose pty survived in the
  detached terminal-server) / `redispatch` (control step — those die with the
  process and are re-runnable) / `error` (agent step whose pty is gone; its
  callback can never arrive, so surface it instead of hanging) / `skip`. A
  `stepSessionAlive: null` ("couldn't probe the terminal-server") re-adopts —
  "can't tell" is never treated as "gone". `findStepSessionId` matches a live
  pty to a step by cwd. The IO wrapper is `../recovery/workflowRunResume.ts`.
- `stepMarkdown.ts` — `renderStepMarkdown` (the WORKFLOW_STEP.md prompt)
  and `effectiveStepHarness` (run override → step harness → `'claude'`).
  Completion instructions branch on harness: Claude relies on its silent
  Stop hook; Pi/codex are told to curl `/complete` explicitly (their
  `session_shutdown` extension / Codex Stop hook is the backstop).
  **Planner-only contract:** the brief's "you are planning, not implementing"
  section sits *above* `{{step_prompt}}` and explicitly outranks it. It used to
  be three lines buried mid-document, and Claude's completion line read "After
  creating all the tasks described above, simply stop" — which a step whose
  prompt named no tasks read as an unfilled template, dismissed, and then
  implemented + committed the work itself (2026-08). Keep the rule above the
  prompt, keep it unconditional, and don't reintroduce completion wording that
  presupposes the step prompt enumerated tasks. The shipped step prompts
  themselves are kept planner-only by
  `../workflows/defaultPromptMigrations.ts`.
- `stepSpawner.ts` — `spawnWorkflowStep`: the coordinator, split into
  named setup phases (`prepareStepScratch`, `writeStepAssets`,
  `installStepCallbacks`, `spawnStepSession`). Creates
  `<project>/.lattice/workflow-steps/<runId>/step-<N>/`, writes
  `WORKFLOW_STEP.md` + `create-task.cjs`, installs the Claude Stop hook,
  the Pi `session_shutdown` extension, AND the Codex `.codex/hooks.json` Stop
  hook (`../codexStopHook.ts`, `always` — the step cwd is fresh scratch under
  `.lattice/`) — all three always, defence-in-depth. The Codex Stop hook is what
  makes a Codex step advance on turn completion instead of relying on the model's
  curl (so it can't linger/overlap the next step). It then
  delegates command assembly and queued pty spawn to the modules below. It
  re-exports `writeScratchReadme` / `pruneOldWorkflowRuns` /
  `workflowStepAgentId` so existing importers keep resolving them here.
- `scratchDirectory.ts` — scratch-dir lifecycle: `writeScratchReadme`
  (tags the run dir as not-the-source-of-truth, idempotent) and
  `pruneOldWorkflowRuns` (keeps the newest `WORKFLOW_RUN_RETENTION` runs,
  and always preserves EVERY still-`running` run — the caller passes
  `getRunningRunIds(project)` in, mirroring the homeScratch sweep's live-PTY
  guard, so a concurrent run parked on a long step can't be pruned out from
  under the backend; the recursive delete is path- and reparse-point-bounded
  so it can't walk a junction loop into `.git`).
- `commandBuilder.ts` — `buildWorkflowStepCommand`: workflow-step prompt
  wording plus harness dispatch through the shared `agentCommandBuilder.ts`
  utility (Claude permission flag, Pi model flag, Codex prompt quoting).
- `stopHookGate.ts` — the **Claude Stop-hook quiescence gate**. Claude's `Stop`
  hook is not a reliable "session fully done" signal when the step agent uses the
  Task tool: it fires early and repeatedly (reproduced against Claude Code
  2.1.218 — a `Stop` landing while a subagent was still running, ~8s before the
  session truly ended). The first premature `Stop` used to advance the run and
  spawn step N+1 while step N's agent kept working → steps ran in parallel
  (intermittent — "sometimes the steps overlap"). So a Stop-hook-sourced
  `/complete` (`source=claude-stop-hook-*`) no longer advances directly:
  `requestStopHookStepComplete` waits until the step session is **quiescent** (no
  subagents in flight AND no signal — tool use / subagent start-stop / a later
  Stop — for `STOP_HOOK_SETTLE_MS`), then advances once. The model's own explicit
  curl and Pi's `session_shutdown` extension are deliberate end-of-work signals
  and still advance immediately; control steps never hit the route. Fed by
  `../agentQuiescence.ts` (per-session `liveSubagents` / `lastSignalAt`), which
  the agent-activity route (`routes/agentActivity.ts`) updates from the very
  hooks that already drive the graph's satellites. `cancelStopHookGate` clears a
  pending gate on run cancel.
- `sessionSpawner.ts` — `workflowStepAgentId` + `enqueueWorkflowStepSession`:
  routes the pty allocation through the spawn queue (fire-and-forget), tracks
  each step's dedupe key / spawned `serverId` for cancellation, registers the
  orange agent-session presence node for a Claude step, and fans out
  `step-spawned`. Pre-spawning the pty is what lets the frontend lazy-mount
  terminals so a multi-step run doesn't burn a WebGL context per pane. Also
  `killWorkflowStepSession(runId, stepIndex)` — kills + forgets a step's tracked
  pty on genuine advance (called from the `/complete` route's `advance()` before
  the next step spawns). Interactive `codex --yolo` never self-exits after its
  turn, so without this the finished step's session leaks *and* stays live
  alongside the next step; killing on advance reclaims it and closes that overlap
  window. Harness-agnostic no-op for an already-exited session; `cancelWorkflow-
  StepSessions` (run cancel) shares the same `killWorkflowStepServer` teardown.
- `projectDirtyState.ts` — `getProjectDirtyState` (probe `git status
  --porcelain` of the project repo) + `renderDirtyStateWarning` (render a
  markdown banner listing the diverged paths). `stepSpawner` calls the
  probe before rendering and passes the result to `renderStepMarkdown`,
  which injects the banner at the very top of `WORKFLOW_STEP.md` when
  non-empty. Reason: task worktrees check out from HEAD, so a planner that
  inspects the dirty working tree and writes tasks against a WIP refactor
  produces tasks whose paths the executors can't find — looks like
  hallucinated codebase, is actually a working-tree mismatch. Probe is
  best-effort: a non-git project / status failure resolves to `null` and
  no banner is rendered.
- `renderHelperScript.ts` + `create-task-template.cjs` — interpolated
  Node CJS helper script copied into each step dir so the agent can
  create tasks without shell-quoting headaches. It also fronts the
  progressive-disclosure read path so a planner never has to hand-build a
  URL: `--summary` (counts + per-lane token cost), `--list` (the API's own
  default — active lanes, compact, newest 100; `all` / a lane CSV /
  `--since` / `--limit` widen it), `--find` (search instead of listing),
  `--get <id>` (one task's full text). Every read prints the envelope's
  `hint` verbatim — that string is how the agent learns the next knob — and
  a 413 is rendered as its hint + `suggestions` rather than a stack trace.
  The `.cjs` template is a runtime asset; `scripts/copy-assets.mjs` mirrors
  it into `dist/`.
- `controlStep.ts` + `controlSteps/` — headless control-flow steps
  (`start` / `merge` / `push`) that run server-side against Lattice's own
  task pipeline instead of spawning an agent. `controlStep.ts` is the thin
  dispatcher: it owns the per-project run-lock lifecycle (acquire →
  kind→worker dispatch → **release BEFORE `completeStep`**), cancellation /
  not-running guards, and the public surface (`executeControlStep`,
  `CompleteStepCallback`). The per-kind workers live under `controlSteps/`:
  - `controlSteps/start.ts` — `runStartStep`: move every Open task to In
    Progress and run it (one `workflow-task-spawned` terminal tab each);
    throws if every task failed to start (nothing started or cap-deferred)
    so a no-op run doesn't silently "succeed".
  - `controlSteps/merge.ts` — `runMergeStep`: Phase A drains In Progress,
    Phase B loops merge runs (`lockMode: 'inherit'`) until Ready-to-Merge
    is empty, with the unchanged-lane error-loop guard, and Phase C waits
    out any running post-merge hook (incl. ones fired *outside* a merge run
    by `awaitPostMergeHookOutsideRun`, which nothing else gates) so a queued
    workflow can't start on top of the previous one's hook.
  - `controlSteps/push.ts` — `runPushStep`: drain Ready-to-Merge, spawn a
    push session, wait for its Stop hook with the `PUSH_STEP_TIMEOUT_MS`
    (15 min) backstop and prompt cancel/pty cleanup.
  - `controlSteps/shared.ts` — `waitForLaneEmpty` (lane-drain subscription,
    subscribes before the initial read; resolves on cancellation) and
    `emitControlProgress` (the single `step-control-progress` WS shaper).

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

- **A run must survive the backend process.** The registry in `state.ts` is
  in-memory, and the backend restarts routinely (`tsc -w` + the dev runner on
  any `backend/src` change, a crash, a processGuards fail-fast). `dev.mjs`
  defers a restart only while a per-project `run.lock` is held — i.e. during
  **control** steps only — so the whole of every agent step is exposed. Losing
  the run there is silent and total: `/api/workflow-runs/active` goes empty (the
  navbar chip vanishes), and the step's agent — whose pty lives in the detached
  terminal-server and *does* survive — later POSTs `/complete` into a backend
  with no such run, where `completeWorkflowStep` returns silently. Every
  remaining step never runs. `persistence.ts` + `../recovery/workflowRunResume.ts`
  close that hole; keep the mirror current whenever run state changes, and keep
  `restoreWorkflowRun` idempotent (a restore must never clobber a live run).
- Step advancement is sequential and **idempotent**: `completeWorkflowStep`
  claims `currentStepIndex` synchronously before any await so a duplicate
  Stop-hook fire is a no-op. The frozen-step skip happens *after* that claim
  (it needs the loaded definition): the claim moves to `stepIndex + 1` first,
  then re-claims + re-mirrors at the step actually dispatched. Keep that order
  — claiming the skipped-to index synchronously would need the definition
  before the dedupe guard.
- **Frozen steps are skipped, not removed.** `currentStepIndex` therefore jumps
  over them, `totalSteps` still counts them, and a run whose remaining steps are
  all frozen **completes** (index parked at `steps.length`) rather than hanging.
  A workflow whose steps are *all* frozen is refused at `startWorkflowRun`
  before any run record exists, so the rejection is side-effect-free.
- **Advancing a step kills its session.** The `/complete` route's `advance()`
  calls `killWorkflowStepSession` (await) *before* `completeWorkflowStep`
  dispatches the next step. An interactive Codex step (`codex --yolo`) never
  self-exits after curling `/complete`, so an eager advance would both leak the
  session and let step N run alongside step N+1. Killing on advance is the fix;
  it's a harmless no-op for a Claude/Pi session that already exited. Keep it
  before the dispatch so the teardown wins the race with the next spawn. Covered
  by `__tests__/workflowStepSpawnFailure.test.ts` ("advancing a spawned workflow
  step kills its terminal session").
- **Claude Stop-hook completions are quiescence-gated, not immediate** (see
  `stopHookGate.ts`). This is the fix for "workflow steps sometimes run in
  parallel": Claude's `Stop` hook fires early/repeatedly when the step agent
  spawns subagents, and an eager advance overlapped step N with step N+1. Keep
  the gate on the `claude-stop-hook-*` source only — the explicit-curl / Pi
  sources are intentional and must stay immediate, and control steps call
  `completeWorkflowStep` directly (never through the gated route).
- The Claude Stop hook is installed for every step regardless of harness
  — same reasoning as task worktrees: a stuck step may need Claude to
  finish it manually.
- Cancellation is authoritative for agent steps: `cancelWorkflowRun` must
  cancel pending `wf-step:<runId>:<step>` queue entries, unregister the
  presence node, and kill any tracked `serverId`; queued thunks must re-check
  run status/current step before and after `proxyCreateSession`.
- **One active run per project is enforceable, not automatic.** The backend
  accepts concurrent runs by default — parallel queue mode and manual ▶ Run
  are intentional. A caller that wants the single-slot guarantee passes
  `requireNoActiveRun` to `startWorkflowRun`, which calls
  `assertNoActiveWorkflowRun` and throws `WorkflowRunConflictError`
  (`routes/workflows/runs.ts` → **HTTP 409**) if any run is `running` for the
  project — *before* any run record / `started` notify / spawn, so a rejected
  start is side-effect-free. The frontend **sequential** queue sets the flag so
  its best-effort `activeRuns` gate can't be raced (a run's startup window, or a
  second browser tab) into starting two runs at once; on the 409 the queue
  requeues the entry and retries when the slot frees. Parallel/manual starts
  omit the flag.
- **The single slot counts workflow runs, not post-merge hooks.**
  `assertNoActiveWorkflowRun` deliberately ignores hooks, and adding them there
  would stall the queue: the 409 retry is re-evaluated only on `runFinished` (a
  workflow run leaving the frontend's `activeRuns`), and a post-merge hook
  finishing emits no such event — the requeued entry would wait for a signal
  that never comes. Hook exclusion is enforced *upstream* instead, by the merge
  control step's Phase C gate (see `controlSteps/CLAUDE.md`). Keep it there.
