# workflows

Components behind the Workflows button. `Workflows.tsx` (parent dir) is a re-export shim.

## Modules

- `WorkflowsLauncher.tsx` — top-level shell. Owns panel visibility and composes the saved-list, editor, queue, and runs sub-panels.
- `WorkflowsSavedList.tsx` — saved workflow list, template picker, and the map over `WorkflowsSavedItem` rows.
- `WorkflowsSavedItem.tsx` — one saved workflow row: select/edit, run/queue buttons, and per-run harness+model override selector (`buildHarnessOptions` via `workflowRunOverrideOptions`; "Default" + harness rows + "Pi — X").
- `WorkflowEditorEmptyState.tsx` — empty editor quick-start pane.
- `WorkflowEditorPanel.tsx` — populated editor body: the structural shell wiring the name input, run strip, variables, step rows, quick-add bar, and action footer. Renders `WorkflowVariablesPanel` above the steps and passes each step the set of defined variable names for prompt highlighting. The two large inline JSX clusters are extracted into `WorkflowQuickAddBar`/`WorkflowEditorActions` (below).
- `WorkflowQuickAddBar.tsx` — the bottom "Quick add" chip bar: the Start/Merge/Push control chips plus one chip per project-tailored default prompt (`promptsWithProjectVariants(DEFAULT_PROMPTS, projectProfile)`, memoized per profile). Each click appends a step via `onAddControlStep`/`onAddDefaultPromptStep`.
- `WorkflowEditorActions.tsx` — the editor action footer (Delete / Discard / Save-or-Create / Queue / Run-or-Stop) with the blocked-reason tooltips that name a disabled button's unblock condition. Fed only the booleans + handlers it needs.
- `WorkflowVariablesPanel.tsx` — the collapsible "Variables" section at the top of the editor: the built-in `user_instructions` box (always present, can't be renamed/removed) plus user-added custom variables. An info popover explains `{{name}}` injection. Step prompts reference variables as `{{name}}`; the backend substitutes them at run time (`renderStepMarkdown` → `interpolateWorkflowVariables`). The panel is just the head + duplicate-name detection + the map; UI state and each row are extracted (below).
- `useWorkflowVariablesPanelState.ts` — the panel's UI-only state hook: per-card collapse set (`isCollapsed`/`toggle`), the info-popover `showInfo` toggle, and the transient "Copied!" flag (`copiedId`/`copyToken`, with the ref-held reset timer). Token-copy only flips to "Copied!" once `copyVariableToken` actually lands.
- `WorkflowVariableCard.tsx` — one variable row/card: name input (read-only for built-in `user_instructions`), `{{token}}` copy button, remove button (hidden for built-in), and the value textarea. `duplicate`/`collapsed`/`copied` are derived by the parent panel and passed in; name edits go through `sanitizeVariableNameInput`.
- `promptVariables.ts` — shared frontend helpers mirroring the backend grammar: `USER_INSTRUCTIONS_VAR`, `VAR_TOKEN_RE`, name sanitization, `defaultVariables`/`ensureUserInstructions`, `withUserInstructions` (appends `{{user_instructions}}` to built-in template/quick-add prompts), and `splitPromptSegments` (drives the `{{var}}` highlight overlay in `StepRow`).
- `QueuePanel.tsx` — queue mode, controls, and queued workflow list.
- `WorkflowRunsAside.tsx` — right rail wrapper with active/recent run cards.
- `WorkflowRunChip.tsx` / `WorkflowRecentFailureChip.tsx` — compact active and recent-failure run rows rendered by the aside.
- `hooks/useWorkflowManager.ts` — thin composition layer over the smaller workflow hooks below; assembles the `WorkflowManager` interface the panels render.
- `hooks/useWorkflowPromptCustomization.ts` — prompt-customization state/action hook: custom instructions prompt, harness terminal spawn, polling, editor patching, and errors.
- `hooks/useWorkflowList.ts` / `hooks/useWorkflowRuns.ts` / `hooks/useWorkflowEditor.ts` / `hooks/useCollapsedSteps.ts` / `hooks/useWorkflowErrorHandler.ts` — saved-list, live/recent-run, editor, step-collapse, and toast state.
- `hooks/useWorkflowRunViews.ts` — derives active/recent run rows for the aside without bloating `useWorkflowRuns`.
- `hooks/useWorkflowHarnessOverrides.ts` — harness availability + the curated Pi model menu (`piMenu`, threaded to each step's harness select) come from the shared `useHarnessAvailability` / `usePiModelMenu` hooks (so they refetch when Settings → Pi saves); this hook keeps only the per-workflow run-override map. The override is stored as `{harness, piModel}`; `getWorkflowHarnessOverride` returns the harness, `getWorkflowPiModelOverride` the model, and `setWorkflowHarnessOverride(id, harness, piModel?)` sets both (model kept only when harness is `pi`). Run/enqueue paths thread `piModelOverride` through to `startWorkflow` and each queue entry, so the per-run override picker now selects "Pi — X" models too (backend already consumed `piModelOverride`).
- `hooks/useWorkflowRunActions.ts` — `startWorkflowDefinition` / `runWorkflow` / `runEditorWorkflow` / `stopRun` (saves before run when the editor is dirty).
- `hooks/useWorkflowQueue.ts` — React adapter for `queueScheduler` (state + dispatch + lifecycle-WS diff).
- `hooks/useWorkflowQueueActions.ts` — enqueue/remove/clear/start/stop/setMode callbacks; `enqueueEditorWorkflow` saves first when the editor is dirty.
- `hooks/useWorkflowQueueSelectors.ts` — derives `queuedItems`, `busy`, `disabled`, and the status string consumed by the queue panel.
- `StepRow.tsx` — thin dispatcher for one editor row: an `agent` step renders `AgentStepRow`, a `start`/`merge`/`push` control step renders `ControlStepRow`. `React.memo` keeps a keystroke in one step from re-rendering its siblings. Re-exports the drag/drop MIME `application/x-lattice-workflow-step` and `PROMPT_MIN_HEIGHT_PX` from `StepRowHooks`. The whole family takes an optional `runStatus` prop (`running`/`done`/`pending`/`error`) so a live run turns the editor into an execution view: the `#N` badge becomes a spinner/check/alert glyph, the row gets an accent (or red) left rail / dims when pending, and the running row auto-scrolls into view.
- `AgentStepRow.tsx` — the full agent-step shell: draggable container + grip + scroll-into-view-when-running, composing `AgentStepHeader` and `PromptHighlightTextarea`. Memoized.
- `AgentStepHeader.tsx` — the agent step's top row (collapse toggle, status badge, title input, mode + harness selects, customize/remove actions) plus the `StepHarnessSelect` (per-step harness select that expands to "Pi — X" rows via `buildHarnessOptions` over `piMenu`, setting both `step.harness` and `step.piModel`). Memoized on the specific header fields (not the whole `step`) so prompt edits don't re-render it.
- `PromptHighlightTextarea.tsx` — the agent step's prompt editor: the transparent textarea over the `{{variable}}`-highlighting overlay (`splitPromptSegments`). Owns its textarea ref + autosize; memoized on the prompt-only props so title/mode/harness edits don't re-tokenize the prompt (the per-row hot path). Stays mounted across collapse, rendering nothing while collapsed.
- `ControlStepRow.tsx` — the compact control-step row (start/merge/push): title + info tooltip via `CONTROL_STEP_META`; no prompt or harness, but still reorders/removes. Memoized.
- `StepRowShared.tsx` — bits shared across the row family: the `StepIndexBadge` (the `#N` badge / run-status glyph) and the `StepRowCallbacks` type (the id/index-parameterized handlers the parent hands down once each).
- `StepRowHooks.ts` — colocated StepRow internals for drag/drop state, prompt textarea autosizing (`PROMPT_MIN_HEIGHT_PX`), and `useScrollRunningIntoView` (scrolls a row into view the moment it becomes the running step).
- `stepRunStatus.ts` — pure `stepRunStatus(index, run)` mapping a row index onto the active/recent run's `currentStepIndex` → the `StepRunStatus` enum StepRow renders. `WorkflowEditorPanel` computes it per row from `runForEditor ?? recentForEditor`. Unit-tested in `src/__tests__/stepRunStatus.test.ts`.
- `WorkflowRunStrip.tsx` — progress / summary strip above the editor name input.
- `editorState.ts` — `EditorState` type + `emptyEditor`, `localStepId`, `fromTemplate`, `fromWorkflow`. Editor keeps a `dirty` flag so unsaved changes show "Discard"/"Save".
- `defaultPrompts.ts` + `prompts/*.md` — quick-add prompt metadata and raw markdown prompt assets. Keep existing raw prompt bytes stable when moving/editing prompt bodies.
- `projectPromptVariants.ts` — thin facade re-exporting `projectStackDetection.ts` + `promptTemplates.ts` so importers have one entry point. Project-stack heuristics and project-aware variants for the refactor / bug-catcher prompt templates only.
- `projectStackDetection.ts` — stack detection/profiling: framework signals, the `PROJECT_STACKS` table, and `detectProjectPromptProfile` (which stacks a scan matches + the guidance that follows).
- `promptTemplates.ts` — prompt-template matching + project-variant generation: `PROMPT_TEMPLATE_METADATA`, `inferPromptTemplateId`/`promptTemplateTitle`, and `promptWithProjectVariant`/`promptsWithProjectVariants`.

## Styles

Workflow CSS is split under `frontend/src/styles/workflows/`; `styles/workflows.css` is the ordered aggregator with comments for `shell`, `list`, `templates`, `editor-shell`, `runs-shell`, `queue`, `runs`, `editor-empty`, `editor`, `steps`, `actions`, and `chips`.

## Run flow

1. `runWorkflow(wf)` saves first if `editor.dirty`, then `apiStartWorkflow(wf.id, { harnessOverride })`. `null` override means each step uses its stored harness.
2. Backend creates the run, materializes the first step's directory, and returns `{run}`. `useWorkflowRuns` stashes the run in `activeRuns`.
3. Per step, the backend emits a `step-spawned` event on `/ws/workflow-runs` with `{stepIndex, cwd, command, serverId}`. `useWorkflowRuns` turns each one into an `addTerminal({...})` call so the step opens as a terminal tab in that step's working directory.
4. The next step's `step-spawned` arrives when the prior step finishes — workflow steps are sibling terminal sessions in step directories, not task-board worktrees.
