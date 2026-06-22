# frontend/src/components/workflows/hooks

Private hooks behind the Workflows feature. Components should import
`useWorkflowManager` only; the other hooks are implementation details composed
there.

- `useWorkflowManager.ts` — feature-level composer: saved-list/editor/run/queue
  state, harness overrides, prompt-customization state/actions, and intent-level actions for the panels.
- `useWorkflowList.ts` — hydrate/sort saved workflows and stay synced via
  `/ws/workflows`.
- `useWorkflowEditor.ts` — mutable editor draft plus save/discard/delete,
  templates, prompt chips, and step reorder/patch actions.
- `useWorkflowQueue.ts` — React adapter around the pure `queueScheduler`; starts
  queued runs and advances from active-run diffs. Feeds the scheduler a
  `StepContext` each tick — the count of active runs the queue didn't dispatch
  (a manual ▶ Run, or another tab). That external count makes the sequential
  gate wait behind a manual run and makes an enqueue auto-start the queue when a
  run is already in flight (so "queue it while one is playing" runs the new
  entry without a second Start-queue click).
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
