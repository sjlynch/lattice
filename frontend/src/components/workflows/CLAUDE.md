# workflows

Components behind the Workflows button. `Workflows.tsx` (parent dir) is a re-export shim.

## Modules

- `WorkflowsLauncher.tsx` — top-level. Hosts the saved-list aside + editor section. WS subscribes to `/ws/workflows` (definitions) and `/ws/workflow-runs` (runs). On `task-spawned` it calls `addTerminal`.
- `StepRow.tsx` — one row in the editor. Drag-and-drop reorder uses MIME `application/x-lattice-workflow-step` (constant in this file).
- `WorkflowRunStrip.tsx` — progress / summary strip above the editor name input.
- `editorState.ts` — `EditorState` type + `emptyEditor`, `localStepId`, `fromTemplate`, `fromWorkflow`. Editor keeps a `dirty` flag so unsaved changes show "Discard"/"Save".

## Run flow

1. `runWorkflow(wf)` saves first if `editor.dirty`, then `apiStartWorkflow(wf.id)`.
2. Backend creates the first step's task + worktree and returns `{run, spawn}`.
3. We `addTerminal({...spawn})` for step 0.
4. Subsequent steps land via the `task-spawned` WS event when the prior step reaches `qa`.
