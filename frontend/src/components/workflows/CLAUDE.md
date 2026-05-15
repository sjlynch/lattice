# workflows

Components behind the Workflows button. `Workflows.tsx` (parent dir) is a re-export shim.

## Modules

- `WorkflowsLauncher.tsx` — top-level shell. Owns panel visibility and composes the saved-list, editor, queue, and runs sub-panels.
- `WorkflowsSavedList.tsx` — saved workflow list, template picker, run/queue buttons, and per-run harness override selector (`WorkflowListPanel.tsx` is a compatibility alias).
- `WorkflowEditorEmptyState.tsx` — empty editor quick-start pane.
- `WorkflowEditorPanel.tsx` — populated editor body, quick-add prompts, prompt-customization button wiring, save/queue/run actions.
- `QueuePanel.tsx` — queue mode, controls, and queued workflow list.
- `WorkflowRunsAside.tsx` — right rail wrapper with active run cards (`WorkflowRunsPanel.tsx` is a compatibility alias).
- `hooks/useWorkflowManager.ts` — thin composition layer over the smaller workflow hooks below; assembles the `WorkflowManager` interface the panels render.
- `hooks/useWorkflowPromptCustomization.ts` — prompt-customization state/action hook: custom instructions prompt, harness terminal spawn, polling, editor patching, and errors.
- `hooks/useWorkflowList.ts` / `hooks/useWorkflowRuns.ts` / `hooks/useWorkflowEditor.ts` / `hooks/useCollapsedSteps.ts` / `hooks/useWorkflowErrorHandler.ts` — saved-list, live-run, editor, step-collapse, and toast state.
- `hooks/useWorkflowHarnessOverrides.ts` — harness availability fetch + per-workflow harness-override map.
- `hooks/useWorkflowRunActions.ts` — `startWorkflowDefinition` / `runWorkflow` / `runEditorWorkflow` / `stopRun` (saves before run when the editor is dirty).
- `hooks/useWorkflowQueue.ts` — React adapter for `queueScheduler` (state + dispatch + lifecycle-WS diff).
- `hooks/useWorkflowQueueActions.ts` — enqueue/remove/clear/start/stop/setMode callbacks; `enqueueEditorWorkflow` saves first when the editor is dirty.
- `hooks/useWorkflowQueueSelectors.ts` — derives `queuedItems`, `busy`, `disabled`, and the status string consumed by the queue panel.
- `StepRow.tsx` — one row in the editor. Drag-and-drop reorder uses MIME `application/x-lattice-workflow-step` (re-exported from this file).
- `StepRowHooks.ts` — colocated StepRow internals for drag/drop state and prompt textarea autosizing (`PROMPT_MIN_HEIGHT_PX`).
- `WorkflowRunStrip.tsx` — progress / summary strip above the editor name input.
- `editorState.ts` — `EditorState` type + `emptyEditor`, `localStepId`, `fromTemplate`, `fromWorkflow`. Editor keeps a `dirty` flag so unsaved changes show "Discard"/"Save".
- `defaultPrompts.ts` + `prompts/*.md` — quick-add prompt metadata and raw markdown prompt assets. Keep existing raw prompt bytes stable when moving/editing prompt bodies.
- `projectPromptVariants.ts` — project-stack heuristics and project-aware variants for the refactor / bug-catcher prompt templates only.

## Styles

Workflow CSS is split under `frontend/src/styles/workflows/`; `styles/workflows.css` is the ordered aggregator with comments for `shell`, `list`, `templates`, `editor-shell`, `runs-shell`, `queue`, `runs`, `editor-empty`, `editor`, `steps`, `actions`, and `chips`.

## Run flow

1. `runWorkflow(wf)` saves first if `editor.dirty`, then `apiStartWorkflow(wf.id, { harnessOverride })`. `null` override means each step uses its stored harness.
2. Backend creates the run, materializes the first step's directory, and returns `{run}`. `useWorkflowRuns` stashes the run in `activeRuns`.
3. Per step, the backend emits a `step-spawned` event on `/ws/workflow-runs` with `{stepIndex, cwd, command, serverId}`. `useWorkflowRuns` turns each one into an `addTerminal({...})` call so the step opens as a terminal tab in that step's working directory.
4. The next step's `step-spawned` arrives when the prior step finishes — workflow steps are sibling terminal sessions in step directories, not task-board worktrees.
