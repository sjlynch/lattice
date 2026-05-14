# frontend/src/components/workflows/hooks

Private hooks behind the Workflows feature. Components should import
`useWorkflowManager` only; the other hooks are implementation details composed
there.

- `useWorkflowManager.ts` — feature-level composer: saved-list/editor/run/queue
  state, harness overrides, and intent-level actions for the panels.
- `useWorkflowList.ts` — hydrate/sort saved workflows and stay synced via
  `/ws/workflows`.
- `useWorkflowEditor.ts` — mutable editor draft plus save/discard/delete,
  templates, prompt chips, and step reorder/patch actions.
- `useWorkflowQueue.ts` — React adapter around the pure `queueScheduler`; starts
  queued runs and advances from active-run diffs.
- `useWorkflowRuns.ts` — `/ws/workflow-runs` state, recent-run linger, and
  per-step terminal spawning through `TerminalsContext`.
- `useCollapsedSteps.ts` — persisted per-step collapse state in
  `userSettings.workflowStepsCollapsed`.
- `useWorkflowErrorHandler.ts` — shared auto-dismissing error toast state.
