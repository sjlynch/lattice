# frontend/src/components/workflows/hooks

Private hooks behind the Workflows feature. Components should import
`useWorkflowManager` only; the other hooks are implementation details composed
there.

- `useWorkflowManager.ts` — feature-level composer: saved-list/editor/run/queue
  state, harness overrides, prompt-customization state/actions, and intent-level
  actions for the panels. The derived run views and the queue/actions object
  assembly are split out (`useWorkflowRunViews` + the local `buildQueueView` /
  `buildActions` helpers) so the body reads as plain wiring. Reselect is a no-op;
  blank/select/template replacement all use the Save/Discard/Cancel gate and
  recheck the editor lifetime before continuing after confirmation or Save.
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
  collapsed. Every editor has an in-memory symbol identity: edits keep it,
  replacements/restores renew it. Async mutations also capture a project
  generation (including A -> B -> A); stale saves return null and cannot alter
  the new editor, draft storage, error toast, or saving flag. `setEditor` writes
  through to a ref so replacements and saved ids are visible before re-render.
  `save()` is single-flight within that lifetime (and `saving` disables Save),
  so a double-clicked Create on
  a never-saved draft — or a Run / Queue, which save first — can't POST two
  identical workflows. A caller that joined a pending save saves again once it
  settles if the editor is still dirty (an edit landed mid-save), so ▶ Run acts
  on what the editor shows, not the pre-edit steps. Joiners retain their original
  lifetime and project; a new editor's Save never joins an old save. Templates
  seed a fresh draft immediately and auto-save through the same path, preserving
  edits on success and leaving an editable draft on failure. The reconcile effect only
  resets the editor for a workflow that was in the list and left it — a
  just-created one may reach the list after the POST response.
- `useEditorDraftLifecycle.ts` — the editor's draft side effects: keep a loaded
  workflow reconciled against the live list, restore/persist the per-project
  never-saved draft, and guard one project's draft from leaking onto another's
  storage key on a project switch. Restores before paint, renewing the editor
  identity; live-list refreshes preserve that identity. Returns nothing.
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
  `startWorkflow`. The start POST goes through `retryTransient` (`api/retry.ts`),
  so a backend restart / its 503 `workflow-recovering` window is waited out with
  backoff — the queue entry stays dispatched instead of being dropped as
  `failed`; a 409 after an attempt whose response was lost adopts the matching
  active run (same workflow, started since the first attempt) as `started`
  rather than requeuing behind what is really its own run. Returns a discriminated `StartOutcome` (`started` / `finished`
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
  An in-flight guard (per workflow id, plus an editor key that also claims the
  editor's loaded workflow id) drops a click while that start is still pending —
  `activeRuns` is empty until the first POST/WS lands, so a double-click would
  otherwise read its own 409 as "busy" and queue a second full run.
  `startingWorkflowIds` / `editorStarting` disable the ▶ buttons meanwhile.
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
  `startOutcomeActions.ts` maps each `/run` `StartOutcome` to queue actions and
  splits vanished runs; the hook keeps the refs and side effects. `busy` (the
  409) requeues via `dispatchRejected` with a two-second minimum retry delay,
  no error toast. Admission stays deferred even if the socket still shows an
  empty slot, then retries without requiring a socket event; a known active
  run still blocks admission after the delay. Timers and start continuations
  are fenced by project generation and unmount; Stop/removal/clear cancel a
  deferred retry, and stale timers cannot release a newer retry for the same
  entry. A run leaving `activeRuns` with no `recentRuns` entry vanished from a
  `hello` full-replace: never read as `'completed'` (cascading the next workflow
  onto a killed run's pending tasks was the "second workflow continues, leaving
  open + unmerged tasks" bug) nor `'errored'` on the spot (that stopped the
  queue on every backend restart). For a run the queue owns,
  `vanishedRunResolver.ts` waits a grace (3 s), then asks
  `GET /api/workflow-runs/:id`: back in `activeRuns` → nothing; a recorded final
  status → reported; 404 → `'errored'`, which STOPS the queue; unreachable →
  re-asked, `'errored'` after 3 min.
  `fetchRun` / `vanishedRunTiming` are test seams. Covered by
  `src/__tests__/backendRestartResilience.test.ts`. Queue state is **per-project**:
  WorkflowsLauncher isn't remounted on a project switch, so the hook resets to
  `initialQueueState` on an `activeFolder` change (mirroring `useWorkflowRuns`)
  and re-baselines its activeRuns diff — otherwise the new project would render
  the previous project's running/queued status and the diff would
  dispatchFail-drop the prior project's pending entry. Regression-covered in
  `src/__tests__/useWorkflowQueueProjectScope.test.ts`.
- `startOutcomeActions.ts` — the queue's pure halves: `queueActionsForStartOutcome`
  (`finished` → `runFinished` then `workflowStarted`, so a completion WS that beat
  `/run` still retires the entry with its terminal status, stopping the queue
  on error/cancellation; another project's run → `dispatchFailed`) and
  `classifyVanishedRuns` (report now vs. hand to `vanishedRunResolver`).
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
- `vanishedRunResolver.ts` — `resolveVanishedRun(deps)`: the grace → lookup →
  retry policy above, as a pure async function with injectable sleep/clock.
- `workflowRunSync.ts` — pure, side-effect-free state transitions + linger
  constants for the active/recent/control-progress maps (`activeRunsFromHello`,
  `mergeRecoveringHello` (a `recovering: true` hello — backend still
  re-registering persisted runs after a restart — is upserted, never removes),
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
- `usePostMergeHookConfigured.ts` — one `fetchUserSettings` per project: does
  it have a post-merge hook prompt? Feeds the Run tests row's "the tests may run
  twice" note (informational only; answers are stamped with their folder so a
  project switch never shows the previous project's).
- `useWorkflowErrorHandler.ts` — shared auto-dismissing toast state (errors,
  plus `useWorkflowManualRun`'s "Queued behind" notice).
- `useWorkflowPromptCustomization.ts` — owns per-step customization state,
  custom-step instruction prompting, terminal creation, polling, editor patching,
  and prompt-customization errors.
