# frontend/src/components/workflows/hooks

Private hooks behind the Workflows feature. Components should import
`useWorkflowManager` only; the other hooks are implementation details composed
there.

- `useWorkflowManager.ts` — feature-level composer: saved-list/editor/run/queue
  state, harness overrides, prompt-customization state/actions, and intent-level
  actions for the panels. The derived run views and the queue/actions object
  assembly are split out (`useWorkflowRunViews` + the local `buildQueueView` /
  `buildActions` helpers) so the body reads as plain wiring.
- `useWorkflowHarnessOverrides.ts` — harness availability (`useHarnessAvailability`)
  + the curated Pi menu (`usePiModelMenu`, threaded to each step's harness select,
  so both refetch when Settings → Pi saves) plus the per-workflow run-override map.
  Each override is stored as one `{harness, piModel}` object;
  `getWorkflowHarnessOverride`/`getWorkflowPiModelOverride` read it and
  `setWorkflowHarnessOverride(id, harness, piModel?)` writes it (the model kept
  only when the harness is `pi`).
- `useWorkflowList.ts` — hydrate/sort saved workflows and stay synced via
  `/ws/workflows`.
- `useWorkflowEditor.ts` — mutable editor draft plus save/discard/delete and
  templates. The bulk is split into two focused helpers it composes:
  `useEditorDraftLifecycle` (the reconcile/restore/persist effects + their
  cross-project draft guards) and `useEditorMutationActions` (the pure
  step/variable `setEditor` updaters — patch/add/remove/reorder, control-step
  and default-prompt additions). Every path that creates agent steps
  (`newBlank`, `newFromTemplate`, and the add actions) reports their ids through
  the `onStepsAdded` arg — the manager points it at
  `useCollapsedSteps.collapseSteps`, which is what makes a new step land
  collapsed.
- `useEditorDraftLifecycle.ts` — the editor's draft side effects: keep a loaded
  workflow reconciled against the live list, restore/persist the per-project
  never-saved draft, and guard one project's draft from leaking onto another's
  storage key on a project switch. Returns nothing.
- `useEditorMutationActions.ts` — the editor's step/variable mutation actions,
  every one a pure `setEditor` updater (no API/draft concerns). The step-adding
  ones mint the new step's id *before* calling `setEditor` (an updater can run
  more than once, so an id created inside it isn't necessarily the committed
  one) and hand it to `onStepsAdded` so the new step starts collapsed.
- `useWorkflowRunViews.ts` — derived run views for the manager: the sorted
  active-run list, the recently-failed list (navbar chip + runs aside), and the
  active/recent/control-progress run that belongs to the currently-edited
  workflow.
- `useWorkflowRunActions.ts` — the run-side callbacks:
  `startWorkflowDefinition`/`runWorkflow`/`runEditorWorkflow`/`stopRun`. Saves a
  dirty editor before running and threads `harnessOverride`/`piModelOverride` to
  `startWorkflow`. Returns a discriminated `StartOutcome` (`started` / `finished`
  (completion WS beat the `/run` response) / `busy` (backend 409: another run is
  active for the project) / `failed`) — `runEditorWorkflow` pairs it with the
  workflow it (possibly just) saved — and guards every await against a mid-flight
  project switch so a result never lands on the wrong project's state.
- `useWorkflowManualRun.ts` — the ▶ Run buttons (editor footer + saved-list row;
  the manager exposes them as `actions.runWorkflow`/`runEditorWorkflow`). A
  project runs one workflow at a time, so when a run is already active (known
  from `activeRuns`, or learned from a `busy` 409) the workflow is enqueued
  instead — by definition for a draft this click just saved, which may not be in
  `workflowsById` yet — the queue is started (so the entry can't sit idle behind
  a queue the user stopped), and the panel toast says "Queued behind <name>" (the
  oldest active run, or "the active workflow" when the 409 beat the WS event).
  Regression-covered in `src/__tests__/useWorkflowManualRun.test.ts`.
- `useWorkflowQueue.ts` — React adapter around the pure `queueScheduler`; starts
  queued runs and advances from active-run diffs. Feeds the scheduler a
  `StepContext` each tick — the count of active runs the queue didn't dispatch
  (a manual ▶ Run, or another tab). The queue is sequential only — one workflow
  run per project. That external count makes the gate wait behind a manual run
  and makes an enqueue auto-start the queue when a run is already in flight (so
  "queue it while one is playing" runs the new entry without a second
  Start-queue click). The `externalActiveCount` gate is best-effort (it only
  sees *this* tab's `activeRuns`, so a run's startup window or a second tab can
  slip past it); the backend is authoritative and 409s any start while a run is
  already active.
  The hook maps a start to one of four `StartOutcome`s: `started` (attach the
  runId), `finished` (the completion WS beat the `/run` response; buffer the
  finish then attach/consume the run id so the queue cannot stall), `busy` (the
  409 — `dispatchRejected` requeues the entry to retry when the slot frees, no
  error toast), or `failed` (drop). The activeRuns-diff `runFinished` uses a
  `?? 'errored'` fallback (not `'completed'`): a run leaving `activeRuns` with no
  `recentRuns` entry never got a terminal WS event — it vanished from a `hello`
  full-replace, i.e. the backend lost the non-persisted run to a restart/crash.
  Treating that as `'errored'` STOPS the queue instead of cascading
  the next workflow onto the killed run's still-pending tasks (the "second
  workflow continues, leaving open + unmerged tasks" bug). Queue state is **per-project**:
  WorkflowsLauncher isn't remounted on a project switch, so the hook resets to
  `initialQueueState` on an `activeFolder` change (mirroring `useWorkflowRuns`)
  and re-baselines its activeRuns diff — otherwise the new project would render
  the previous project's running/queued status and the diff would
  dispatchFail-drop the prior project's pending entry. Regression-covered in
  `src/__tests__/useWorkflowQueueProjectScope.test.ts`.
- `useWorkflowQueueActions.ts` — enqueue/remove/clear/start/stop callbacks
  dispatched into `useWorkflowQueue`. Each enqueue captures the workflow's current
  harness/Pi-model override and reports whether an entry was queued;
  `enqueueEditorWorkflow` saves a dirty editor first so the queued entry reflects
  the latest steps.
- `useWorkflowQueueSelectors.ts` — the queue panel's derived view of scheduler
  state: `queuedItems` (entries joined to their `Workflow`), `busy` (an in-flight
  `/run`, NOT "processing a long-running workflow" — so Clear/Remove stay live once
  the start is acknowledged), `disabled`, and the human status string.
- `useWorkflowRuns.ts` — composition layer for live workflow-run state: owns the
  `activeRuns` / `controlProgress` maps and exposes `addActiveRun` /
  `getRecentRun` / `dismissRecent`. The recent-run linger lives in
  `useWorkflowRecentRuns`, additive mount/visibility recovery fetches in
  `useWorkflowRunRecoveryFetch`, and `/ws/workflow-runs` event routing + per-step
  terminal spawning in `useWorkflowRunSubscription`; the pure state transitions +
  linger constants are in `workflowRunSync.ts`. Recovery: the WS `hello` is the
  authoritative snapshot and the only removal path; fetches are additive-only and
  never remove a run.
- `useWorkflowRecentRuns.ts` — the project-scoped recent-run map and its linger
  timers (`createRecentDismissalScheduler`); clears on folder change, keeps a ref
  for additive fetch reconciliation, and cancels pending dismissals on teardown.
- `useWorkflowRunRecoveryFetch.ts` — additive `/api/workflow-runs/active` fetches
  on mount + tab-visibility return; rehydrates a run a missed socket event dropped
  but never resurrects a finalized recent run (throttled by
  `VISIBILITY_REFETCH_MIN_INTERVAL_MS`).
- `useWorkflowRunSubscription.ts` — subscribes to `/ws/workflow-runs` and routes
  each event (`hello` / `started` / `progress` / terminal / `step-spawned` /
  `workflow-task-spawned` / `step-control-progress`) through the `workflowRunSync`
  reducers + `workflowTerminalSpawns` mappers; clears project-scoped run state on
  every folder change so one project's runs never leak into another's. A
  `step-spawned` also clears that step's `kind: 'agent'` control progress — the
  "running the Opengrep scan before the agent starts…" wait the backend reports
  for a step with pre-run tools, which nothing else would end since the run
  index only moves on completion.
- `workflowRunSync.ts` — pure, side-effect-free state transitions + linger
  constants for the active/recent/control-progress maps (`activeRunsFromHello`,
  `upsertRun`, `removeKey`, `clearStaleControlProgress`,
  `clearControlProgressForStep`, `setControlProgress`,
  `mergeFetchedActiveRuns` additive reconcile, `recentDismissalDelayMs`). Also
  the home of the `ControlProgress` type (re-exported from `useWorkflowRuns`
  for back-compat). Unit-tested in `src/__tests__/workflowRunSync.test.ts`.
- `recentDismissalScheduler.ts` — `createRecentDismissalScheduler(onDismiss)`:
  the linger-timer bookkeeping (one timer per run id, replace-on-reschedule,
  `cancelAll` on cleanup); delay policy comes from `recentDismissalDelayMs`.
- `workflowTerminalSpawns.ts` — maps `step-spawned` / `workflow-task-spawned`
  WS events to `addTerminal` args (`{ spec, focus }`); both spawn with
  `focus: false` so a running workflow never steals the user's currently
  focused terminal tab (`pickActiveAfterAdd` still focuses the spawn when
  nothing is focused yet).
- `useCollapsedSteps.ts` — persisted per-step collapse state in
  `userSettings.workflowStepsCollapsed`. Only `true` entries are stored, so a
  missing key means expanded; newly added steps get an explicit `true` via
  `collapseSteps(ids)` (wired to the editor's `onStepsAdded`) rather than the map
  default being flipped — flipping it would retroactively collapse every step of
  every existing workflow. The map resets on a project switch and loads via
  `fetchUserSettingsStrict`; nothing is PATCHed until that load succeeded (a
  failed GET read as `{}` would otherwise overwrite every saved collapse).
- `useWorkflowErrorHandler.ts` — shared auto-dismissing toast state (errors,
  plus `useWorkflowManualRun`'s "Queued behind" notice).
- `useWorkflowPromptCustomization.ts` — owns per-step customization state,
  custom-step instruction prompting, terminal creation, polling, editor patching,
  and prompt-customization errors.
