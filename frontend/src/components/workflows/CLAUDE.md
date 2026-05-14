# workflows

Components behind the Workflows button. `Workflows.tsx` (parent dir) is a re-export shim.

## Modules

- `WorkflowsLauncher.tsx` — top-level shell. Owns panel visibility and composes the saved-list, editor, queue, and runs sub-panels.
- `WorkflowsSavedList.tsx` — saved workflow list, template picker, run/queue buttons, and per-run harness override selector (`WorkflowListPanel.tsx` is a compatibility alias).
- `WorkflowEditorEmptyState.tsx` — empty editor quick-start pane.
- `WorkflowEditorPanel.tsx` — populated editor body, quick-add prompts, prompt-customization button wiring, save/queue/run actions.
- `QueuePanel.tsx` — queue mode, controls, and queued workflow list.
- `WorkflowRunsAside.tsx` — right rail wrapper with active run cards (`WorkflowRunsPanel.tsx` is a compatibility alias).
- `hooks/useWorkflowManager.ts` — composes list/run/editor/collapse hooks, workflow run callbacks, queue state, and error handling into the interface consumed by the panels.
- `StepRow.tsx` — one row in the editor. Drag-and-drop reorder uses MIME `application/x-lattice-workflow-step` (constant in this file).
- `WorkflowRunStrip.tsx` — progress / summary strip above the editor name input.
- `editorState.ts` — `EditorState` type + `emptyEditor`, `localStepId`, `fromTemplate`, `fromWorkflow`. Editor keeps a `dirty` flag so unsaved changes show "Discard"/"Save".
- `defaultPrompts.ts` + `prompts/*.md` — quick-add prompt metadata and raw markdown prompt assets. Keep existing raw prompt bytes stable when moving/editing prompt bodies.
- `projectPromptVariants.ts` — project-stack heuristics and project-aware variants for the refactor / bug-catcher prompt templates only.

## Run flow

1. `runWorkflow(wf)` saves first if `editor.dirty`, then `apiStartWorkflow(wf.id, { harnessOverride })`. `null` override means each step uses its stored harness.
2. Backend creates the first step's task + worktree and returns `{run, spawn}`.
3. We `addTerminal({...spawn})` for step 0.
4. Subsequent steps land via the `task-spawned` WS event when the prior step reaches `qa`.
