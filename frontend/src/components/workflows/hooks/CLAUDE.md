# frontend/src/components/workflows/hooks

Private hooks behind the Workflows feature. Components should import
`useWorkflowManager` only; the other hooks are implementation details composed
there.

- `useWorkflowManager.ts` — feature-level composer: saved-list/editor/run/queue
  state, harness overrides, prompt-customization state/actions, and intent-level
  actions for the panels. The derived run views and the queue/actions object
  assembly are split out (`useWorkflowRunViews` + the local `buildQueueView` /
  `buildActions` helpers) so the body reads as plain wiring.
- `useWorkflowList.ts` — hydrate/sort saved workflows and stay synced via
  `/ws/workflows`.
- `useWorkflowEditor.ts` — mutable editor draft plus save/discard/delete and
  templates. The bulk is split into two focused helpers it composes:
  `useEditorDraftLifecycle` (the reconcile/restore/persist effects + their
  cross-project draft guards) and `useEditorMutationActions` (the pure
  step/variable `setEditor` updaters — patch/add/remove/reorder, control-step
  and default-prompt additions).
- `useEditorDraftLifecycle.ts` — the editor's draft side effects: keep a loaded
  workflow reconciled against the live list, restore/persist the per-project
  never-saved draft, and guard one project's draft from leaking onto another's
  storage key on a project switch. Returns nothing.
- `useEditorMutationActions.ts` — the editor's step/variable mutation actions,
  every one a pure `setEditor` updater depending only on the stable setter (no
  API/draft concerns).
- `useWorkflowRunViews.ts` — derived run views for the manager: the sorted
  active-run list, the recently-failed list (navbar chip + runs aside), and the
  active/recent/control-progress run that belongs to the currently-edited
  workflow.
- `useWorkflowQueue.ts` — React adapter around the pure `queueScheduler`; starts
  queued runs and advances from active-run diffs. Feeds the scheduler a
  `StepContext` each tick — the count of active runs the queue didn't dispatch
  (a manual ▶ Run, or another tab). That external count makes the sequential
  gate wait behind a manual run and makes an enqueue auto-start the queue when a
  run is already in flight (so "queue it while one is playing" runs the new
  entry without a second Start-queue click). The `externalActiveCount` gate is
  best-effort (it only sees *this* tab's `activeRuns`, so a run's startup window
  or a second tab can slip past it), so **sequential** dispatches also pass
  `requireNoActiveRun` to the backend, which 409s if a run is already active.
  The hook maps a start to one of four `StartOutcome`s: `started` (attach the
  runId), `finished` (the completion WS beat the `/run` response; buffer the
  finish then attach/consume the run id so the queue cannot stall), `busy` (the
  409 — `dispatchRejected` requeues the entry to retry when the slot frees, no
  error toast), or `failed` (drop). Parallel dispatches omit
  the flag — concurrency there is intentional. Queue state is **per-project**:
  WorkflowsLauncher isn't remounted on a project switch, so the hook resets to
  `initialQueueState` on an `activeFolder` change (mirroring `useWorkflowRuns`)
  and re-baselines its activeRuns diff — otherwise the new project would render
  the previous project's running/queued status and the diff would
  dispatchFail-drop the prior project's pending entry. Regression-covered in
  `src/__tests__/useWorkflowQueueProjectScope.test.ts`.
- `useWorkflowRuns.ts` — `/ws/workflow-runs` state, recent-run linger, and
  per-step terminal spawning through `TerminalsContext`. Thin wiring over the
  three helpers below.
- `workflowRunSync.ts` — pure, side-effect-free state transitions + linger
  constants for the active/recent/control-progress maps (`activeRunsFromHello`,
  `upsertRun`, `removeKey`, `clearStaleControlProgress`, `setControlProgress`,
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
  `userSettings.workflowStepsCollapsed`.
- `useWorkflowErrorHandler.ts` — shared auto-dismissing error toast state.
- `useWorkflowPromptCustomization.ts` — owns per-step customization state,
  custom-step instruction prompting, terminal creation, polling, editor patching,
  and prompt-customization errors.
