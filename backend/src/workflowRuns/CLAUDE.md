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
- `stepMarkdown.ts` — `renderStepMarkdown` (the WORKFLOW_STEP.md prompt)
  and `effectiveStepHarness` (run override → step harness → `'claude'`).
  Completion instructions branch on harness: Claude relies on its silent
  Stop hook; Pi/codex get an explicit curl line as a backstop.
- `stepSpawner.ts` — `spawnWorkflowStep`: creates
  `<project>/.lattice/workflow-steps/<runId>/step-<N>/`, writes
  `WORKFLOW_STEP.md` + `create-task.cjs`, installs the Claude Stop hook
  (always) and the Pi `session_shutdown` extension (Pi only), builds the
  harness command, asks the terminal-server to allocate a pty, then
  notifies `step-spawned` + `progress`. Pre-spawning the pty is what lets
  the frontend lazy-mount terminals so a multi-step run doesn't burn a
  WebGL context per pane.
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
  create tasks without shell-quoting headaches. The `.cjs` template is a
  runtime asset; `scripts/copy-assets.mjs` mirrors it into `dist/`.
- `controlStep.ts` + `controlSteps/` — headless control-flow steps
  (`start` / `merge` / `push`) that run server-side against Lattice's own
  task pipeline instead of spawning an agent. `controlStep.ts` is the thin
  dispatcher: it owns the per-project run-lock lifecycle (acquire →
  kind→worker dispatch → **release BEFORE `completeStep`**), cancellation /
  not-running guards, and the public surface (`executeControlStep`,
  `CompleteStepCallback`). The per-kind workers live under `controlSteps/`:
  - `controlSteps/start.ts` — `runStartStep`: move every Open task to In
    Progress and run it (one `workflow-task-spawned` terminal tab each);
    throws if it started none so a no-op run doesn't silently "succeed".
  - `controlSteps/merge.ts` — `runMergeStep`: Phase A drains In Progress,
    Phase B loops merge runs (`lockMode: 'inherit'`) until Ready-to-Merge
    is empty, with the unchanged-lane error-loop guard.
  - `controlSteps/push.ts` — `runPushStep`: drain Ready-to-Merge, spawn a
    push session, wait for its Stop hook with the `PUSH_STEP_TIMEOUT_MS`
    (15 min) backstop and prompt cancel/pty cleanup.
  - `controlSteps/shared.ts` — `waitForLaneEmpty` (lane-drain subscription,
    subscribes before the initial read; resolves on cancellation) and
    `emitControlProgress` (the single `step-control-progress` WS shaper).

## Adding a step-completion harness

1. Add the harness to `WorkflowStepHarness` (in `workflows.ts`).
2. Extend `buildWorkflowStepCommand` in `stepSpawner.ts` for the new
   command shape.
3. If the harness can't reliably curl the completion URL itself, install
   a callback shim alongside the Stop hook in `spawnWorkflowStep` (mirror
   `installPiWorkflowCompletionExtension`).
4. Update `renderStepMarkdown` so the in-prompt completion instructions
   match (silent vs. explicit-curl).

## Invariants

- Step advancement is sequential and **idempotent**: `completeWorkflowStep`
  claims `currentStepIndex` synchronously before any await so a duplicate
  Stop-hook fire is a no-op.
- The Claude Stop hook is installed for every step regardless of harness
  — same reasoning as task worktrees: a stuck step may need Claude to
  finish it manually.
