# frontend/src/components/workflows/hooks

Private hooks behind the Workflows feature. Components import
`useWorkflowManager` only; the rest are implementation details composed there.
The non-hook `.ts` files here are the pure, unit-tested halves. Panel and editor
model detail: [../CLAUDE.md](../CLAUDE.md).

## Map

Composition:
- `useWorkflowManager.ts` — feature composer: list / editor / run / queue state,
  overrides, intent-level actions (`buildQueueView` / `buildActions`).
- `useWorkflowEditorNavigation.ts` — select / blank / template replacement
  callbacks over a narrow editor slice; wires `useConfirm` to
  `guardUnsavedSwitch`.
- `useWorkflowHarnessOverrides.ts` — `useHarnessAvailability` + `usePiModelMenu`
  (both refetch when Settings → Pi saves) + the per-workflow run override, one
  `{harness, piModel}` object each (model kept only for `pi`).
- `useWorkflowList.ts` — hydrate / sort saved workflows, synced via
  `/ws/workflows`.
- `useWorkflowErrorHandler.ts` — auto-dismissing toast over
  `shared/useAutoDismissMessage`.

Editor:
- `useWorkflowEditor.ts` — draft + save / discard / delete / templates; composes
  `useEditorDraftLifecycle.ts` (reconcile against the live list, restore /
  persist the never-saved draft, cross-project guards) and
  `useEditorMutationActions.ts` (pure `setEditor` step / variable updaters; the
  step-adding ones take an optional insertion index for quick-add drops).
- `useCollapsedSteps.ts` — per-step collapse in
  `userSettings.workflowStepsCollapsed`.

Runs:
- `useWorkflowRunActions.ts` — `startWorkflowDefinition` / `runWorkflow` /
  `runEditorWorkflow` / `stopRun`; saves a dirty editor first; returns a
  `StartOutcome`.
- `useWorkflowManualRun.ts` — the ▶ Run buttons (editor footer + saved row).
- `useWorkflowRunViews.ts` — derived run views (sorted active, recently failed,
  the edited workflow's run).
- `useWorkflowRuns.ts` — composes live run state (`activeRuns`,
  `controlProgress`, `addActiveRun` / `getRecentRun` / `dismissRecent`) from
  `useWorkflowRecentRuns.ts` (recent map + linger via
  `recentDismissalScheduler.ts`), `useWorkflowRunRecoveryFetch.ts` (additive
  `/api/workflow-runs/active` on mount + visibility return, throttled by
  `VISIBILITY_REFETCH_MIN_INTERVAL_MS`) and `useWorkflowRunSubscription.ts`
  (`/ws/workflow-runs` routing).
- `workflowRunSync.ts` — pure active / recent / control-progress transitions +
  linger constants; owns the `ControlProgress` type.
- `workflowTerminalSpawns.ts` — `step-spawned` / `workflow-task-spawned` →
  `addTerminal` args.
- `usePostMergeHookConfigured.ts` — is a post-merge hook set? (Run tests note).

Queue:
- `useWorkflowQueue.ts` — React adapter over `../queueScheduler.ts`: starts
  queued runs, advances from active-run diffs, owns refs / timers / side effects.
- `startOutcomeActions.ts` — `queueActionsForStartOutcome`,
  `classifyVanishedRuns` (report now vs. resolve).
- `vanishedRunResolver.ts` — `resolveVanishedRun(deps)`, pure async with
  injectable sleep / clock.
- `useWorkflowQueueActions.ts` — enqueue / remove / clear / start / stop.
- `useWorkflowQueueSelectors.ts` — `queuedItems`, `busy`, `disabled`, status.

## Invariants

### Project scoping
- `WorkflowsLauncher` isn't remounted on a project switch, so run state and
  queue state (`initialQueueState` + a re-baselined `activeRuns` diff) reset on
  every `activeFolder` change — else the new project shows the old one's runs /
  queue and the diff dispatch-fails the prior project's pending entry.
- Every await in run actions is guarded against a mid-flight switch. Async
  editor mutations capture a project generation (A → B → A included): stale
  saves return `null` and can't touch the new editor, draft storage, toast or
  saving flag. `usePostMergeHookConfigured` answers are stamped with their
  folder.

### Editor
- Every editor has an in-memory symbol identity: edits keep it, replacements /
  restores renew it. `setEditor` writes through to a ref so replacements and
  saved ids are visible before re-render. Draft restore runs before paint;
  live-list refreshes keep the identity.
- `save()` is single-flight within a lifetime (`saving` disables Save), so a
  double-clicked Create — or Run / Queue, which save first — can't POST two
  workflows. A joiner saves again if the editor is still dirty after the pending
  save settles, so ▶ Run acts on what the editor shows. Joiners keep their own
  lifetime and project; a new editor's Save never joins an old save.
- Templates seed a fresh draft at once and auto-save through the same path:
  edits kept on success, an editable draft left on failure.
- Reconcile resets the editor only for a workflow that *was* in the list and
  left it — a just-created one may reach the list after the POST response.
- Navigation: re-select is a no-op; dirty checks read live state so mid-save
  edits survive; discard waits for the final editor / project lifetime check
  before replacing.
- **New steps land collapsed** via `onStepsAdded` → `collapseSteps`, reported by
  every agent-step-creating path (`newBlank`, `newFromTemplate`, add actions).
  Mint the step id *before* calling `setEditor` — an updater can run more than
  once, so an id created inside it may not be the committed one.
- `useCollapsedSteps` stores only `true`; new steps get an explicit `true`.
  Never flip the map default — that retroactively collapses every step of every
  workflow. It loads via `fetchUserSettingsStrict` and PATCHes nothing until
  that load succeeded (a failed GET read as `{}` would wipe saved collapses).

### Starting runs
- The start POST goes through `retryTransient` (`api/retry.ts`) with
  `retryIf: err => !mayHaveBeenApplied(err)`: recovery 503 / proxy ECONNREFUSED
  back off and retry (the queue entry stays dispatched). A lost acknowledgement
  (network error, 504, proxy reset) returns `uncertain` with a "check workflow
  status" message. **Never replay the unkeyed POST or infer ownership from
  active runs / timestamps** — the original run may already have finished or
  been cancelled.
- `StartOutcome`: `started` / `finished` (terminal response, or completion WS
  beat it — status preserved) / `busy` (409: another run active) / `uncertain`
  / `failed`; `runEditorWorkflow` pairs it with the workflow it saved.
- Manual ▶ Run with a run active (from `activeRuns` or `busy`) enqueues instead
  — even a draft just saved and not yet in `workflowsById` — **starts the queue**
  (so it can't sit behind a stopped queue) and toasts "Queued behind <name>"
  (oldest active run, or "the active workflow" when the 409 beat the WS).
- An in-flight guard (per workflow id, plus an editor key that also claims the
  editor's loaded id) drops clicks while a start is pending: `activeRuns` is
  empty until the POST / WS lands, so a double-click would read its own 409 as
  busy and queue a second full run. `startingWorkflowIds` / `editorStarting`
  disable the buttons.
- Each enqueue captures the workflow's current override;
  `enqueueEditorWorkflow` saves a dirty editor first.

### Queue
- Sequential: one run per project. Each tick's `StepContext` counts active runs
  the queue didn't dispatch (manual ▶, another tab): the gate waits behind them
  and an enqueue auto-starts the queue while one runs. Best-effort (this tab
  only); the backend's 409 is authoritative.
- `busy` requeues via `dispatchRejected` with a ≥ `BUSY_RETRY_DELAY_MS` (2 s)
  delay and no toast; admission stays deferred even if the socket shows a free
  slot, then retries without needing a socket event; a known active run still
  blocks it. Timers and start continuations are fenced by project generation
  and unmount; Stop / removal / clear cancel a deferred retry; a stale timer
  can't release a newer retry for the same entry.
- `finished` → `runFinished` then `workflowStarted`, so a completion WS that beat
  `/run` still retires the entry with its terminal status (stopping the queue on
  error / cancellation). `uncertain` stops the queue *before* retiring the
  unconfirmed entry, leaving later entries queued. Another project's run →
  `dispatchFailed`.
- Selector `busy` means an in-flight `/run`, NOT "a long workflow is running",
  so Clear / Remove stay live once the start is acknowledged.

### Vanished runs (backend restart)
- A run that leaves `activeRuns` with no `recentRuns` entry vanished in a `hello`
  full-replace. Never read it as `'completed'` (cascades the next workflow onto
  a killed run's pending tasks) nor `'errored'` on the spot (stops the queue on
  every backend restart).
- For a queue-owned run `vanishedRunResolver` waits 3 s, then
  `GET /api/workflow-runs/:id`: back in `activeRuns` → nothing; final status →
  reported; 404 → `'errored'` (stops the queue); unreachable → retry every 5 s,
  `'errored'` 3 min after the *resolver's start* (so after a long poll one
  failed fetch errors); still `running` → re-poll every 10 s with **no cap**.
- That makes it a long-lived poll whose only exit while the backend says
  `running` is `isCancelled` (checked after every sleep / fetch and before the
  hook dispatches) — keep it wired to project switch and unmount.
  `resolvingVanishedRef` holds one resolver per run id. `fetchRun` /
  `vanishedRunTiming` are test seams; pinned by
  `__tests__/backendRestartResilience.vanishedRun.test.ts`.

### Run state
- The WS `hello` is the authoritative snapshot and the only removal path;
  recovery fetches are additive-only and never resurrect a finalized recent run.
  A `recovering: true` hello (backend still re-registering runs) upserts, never
  removes.
- `step-spawned` clears that step's `kind: 'agent'` control progress (the
  pre-run tool wait, e.g. the Opengrep scan); nothing else ends it, since the
  run index only moves on completion.
- Step and task terminals spawn with `focus: false`, so a running workflow never
  steals the focused tab (`pickActiveAfterAdd` still focuses when none is).
- Recent-run linger: one timer per run id, replaced on reschedule, `cancelAll`
  on teardown and folder change.

Tests: named after the module in `frontend/src/__tests__/`; scoping rules in
`*ProjectScope` / `*ProjectSwitch*` tests.
