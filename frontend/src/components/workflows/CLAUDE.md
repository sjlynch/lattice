# workflows

Components behind the Workflows button. `Workflows.tsx` (parent dir) is a
re-export shim. State and actions live in [hooks/](hooks/CLAUDE.md) (panels
import only `useWorkflowManager`); quick-add prompt bodies and their lockstep
rules in [prompts/](prompts/CLAUDE.md). Backend run execution, step briefs and
`{{var}}` substitution: `backend/src/workflowRuns/`, `backend/src/workflows/`.

## Modules

Shell and panels:
- `WorkflowsLauncher.tsx` — top-level shell: panel visibility, composes
  saved-list / editor / queue / runs panels; owns the panel-close unsaved guard.
- `WorkflowsSavedList.tsx` / `WorkflowsSavedItem.tsx` — saved list + template
  picker; one row with select/edit, run/queue and the per-run harness+model
  override `<select>` (options built once by the list).
- `WorkflowEditorEmptyState.tsx` — empty editor quick-start pane.
- `WorkflowEditorPanel.tsx` — populated editor shell: name input, run strip,
  variables, step rows, quick-add bar, action footer.
- `WorkflowQuickAddBar.tsx` — Start / Merge / Run tests / Push chips plus one
  chip per project-tailored default prompt; drag-and-drop in
  `useQuickAddDragDrop.ts`.
- `WorkflowEditorActions.tsx` — footer (Delete / Discard / Save-or-Create / Queue
  / Run-or-Stop) with tooltips naming each disabled button's unblock condition.
- `WorkflowVariablesPanel.tsx` + `WorkflowVariableCard.tsx` +
  `useWorkflowVariablesPanelState.ts` — Variables section: built-in
  `user_instructions` (can't be renamed/removed) + custom variables, duplicate
  detection, `{{token}}` copy ("Copied!" only once `copyVariableToken`
  resolves `true`).
- `QueuePanel.tsx` — queue Start / Stop / Clear, status, entries.
- `WorkflowRunsAside.tsx`, `WorkflowRunChip.tsx`,
  `WorkflowRecentFailureChip.tsx` — right rail of active / recent-failure runs.
- `WorkflowRunStrip.tsx` — progress strip above the name input, plus one
  collapsed "Run tests summary · step N" disclosure per `run.stepSummaries`
  entry (`runTestsSummaries`); `CONTROL_KIND_LABEL` labels pre-spawn progress.

Step rows (all `React.memo`; optional `runStatus` turns the editor into an
execution view):
- `StepRow.tsx` — dispatcher: `agent` → `AgentStepRow`, `test` → `TestStepRow`,
  `start`/`merge`/`push` → `ControlStepRow`. Re-exports the row drag MIME and
  `PROMPT_MIN_HEIGHT_PX` from `StepRowHooks.ts` (drag state, autosize,
  `useScrollRunningIntoView`).
- `AgentStepRow.tsx` → `AgentStepHeader.tsx` (collapse, badge, title,
  `StepHarnessSelect` — "Pi — X" rows via `buildHarnessOptions`, sets
  `harness` + `piModel` — `StepLaunchSelects` for `model` / `effort`, freeze /
  parallel / remove; memoized on
  its specific fields) + `PromptHighlightTextarea.tsx` (textarea over the
  `{{var}}` overlay; memoized on prompt-only props — the per-row hot path; stays
  mounted across collapse, rendering nothing).
- `ControlStepRow.tsx` — compact start/merge/push row via `CONTROL_STEP_META`;
  a Start step's `StepLaunchSelects` set the model / effort of the tasks it starts.
- `StepLaunchSelects.tsx` — model (Claude presets; none under Pi) + effort
  selects; empty = the harness default.
- `TestStepRow.tsx` — Run tests row: no prompt (backend brief `RUN_TESTS.md` is
  fixed), harness + launch selects, `timeoutMinutes`, post-merge-hook note.
- `StepRowShared.tsx` — `StepIndexBadge` (`#N` / status glyph),
  `StepFreezeButton`, `StepOpengrepBadge`, `StepRowCallbacks`.
- `stepRunStatus.ts` — pure row-status mapping; `parallelSteps.ts` — authored
  adjacency groups for the connector + member-aware progress counts shared by
  strip, chips and saved list.

Editor model and helpers:
- `editorState.ts` — `EditorState`, `emptyEditor` / `fromTemplate` /
  `fromWorkflow`, step factories, `collapsibleStepIds` (agent ids only),
  `nextEditorAfterSave`; editor carries `dirty` and an in-memory `identity`
  symbol.
- `unsavedSwitch.ts` — `guardUnsavedSwitch` (Save / Discard / Cancel via
  `confirmUnsaved`; a failed save resolves `null` and aborts).
- `workflowDraftStorage.ts` / `workflowDraftPersist.ts` — never-saved draft in
  `lattice.workflowEditorDraft.<project>`; pure persist decisions for
  `hooks/useEditorDraftLifecycle`.
- `promptVariables.ts` — wraps the backend's variable grammar
  (`backend/src/shared/workflowVariables.ts`): `VAR_TOKEN_RE`,
  `USER_INSTRUCTIONS_VAR`, input sanitization, `withUserInstructions`,
  `splitPromptSegments` (highlight overlay).
- `queueScheduler.ts` — pure queue state machine (`reduceQueue` / `step` /
  `pendingStarts`); React adapter `hooks/useWorkflowQueue`.
- `workflowHarnessOverride.ts` — run-override `<select>` model over the shared
  `pi:<provider/model>` encoding (`harnesses.ts`).
- `defaultPrompts.ts`, `promptTemplates.ts`, `projectStackDetection.ts`,
  `projectPromptVariants.ts` → [prompts/CLAUDE.md](prompts/CLAUDE.md).

## Invariants

- **Every action that replaces the editor's contents goes through
  `guardUnsavedSwitch`** (manager's `selectWorkflow` — skipped on re-select —
  `newBlank`, `newFromTemplate`), else unsaved edits are silently lost. Its
  `isCurrent` check rejects stale confirmations/saves before they touch a
  replacement editor or project.
- `nextEditorAfterSave` reseeds from the server echo only when no edit landed
  mid-save; a superseded create adopts the new id only within the same editor
  lifetime and stays dirty, so the next save PATCHes instead of POSTing a
  duplicate. Edits keep the editor `identity`; replacements/restores renew it.
- Draft storage restores only a draft with real content and `workflowId ===
  null` (saved workflows reload from the server), and never stamps one
  project's draft onto another's key across a switch.
- Variable grammar comes from `backend/src/shared/` — never hand-copy the regex
  or name rules, or the highlight drifts from what the server substitutes.
- A run override is never `interleave`; a Pi model is kept only when the harness
  is `pi`. `null` = each step uses its stored harness/model.
- `queueScheduler`: one workflow at a time per project; deferred 409 retries
  (`dispatchRejected` → `retryReady`); bounded pre-finished-run records keep a
  completion WS that beat the `/run` response, with its terminal status; a
  queue-owned error/cancellation stops progression regardless of arrival order.
- `stepRunStatus`: new runs resolve captured member state by **stable step id**
  so reordering / freezing in the editor can't change live statuses; legacy
  records use `currentStepIndex` + the row's `frozen` flag. Statuses: `running`
  (auto-scrolls; an agent row also when `queued`), `done`, `error`, `queued` (queued / preparing / unspawned
  parallel member), `cancelled`, `skipped` (also frozen-at-start), `pending`. A
  new status needs a glyph + title in `StepRowShared.tsx` and `run-*` rules in
  `styles/workflows/steps.css`.
- Push hint: the workflow Push pushes existing commits only — its brief never
  stages or commits (unlike the Task Board cloud icon).
- Run tests: timeout blank = 60 min, clamped to the backend range on **blur**,
  not per keystroke; it's in no built-in template (the user adds it).
- `StepOpengrepBadge` is read-only on purpose — the scan belongs to the
  Opengrep step; no per-step toggle. Needs Opengrep installed (Settings →
  Tools), else the brief says the scan couldn't run.

## Run flow

1. `runWorkflow` saves first if dirty, then `startWorkflow(id, { harnessOverride,
   piModelOverride })`. One workflow runs per project: the backend 409s a second
   start, so ▶ Run with a run active (known from `activeRuns` or the 409) queues
   it and toasts "Queued behind <name>" (`hooks/useWorkflowManualRun`).
2. Each `step-spawned` on `/ws/workflow-runs` becomes an unfocused
   `addTerminal` in that step's scratch directory (not a task worktree).
3. Adjacent parallel members spawn independently as the spawn queue admits
   them; the next group starts when every member finishes. Only the first
   active member auto-scrolls.

## Freezing steps

The snowflake sets `WorkflowStep.frozen`: the step keeps its place and prompt
but is **skipped at run time** — backend `nextStepGroup`
(`backend/src/workflowRuns/execution.ts`) walks past it, so `currentStepIndex`
jumps over frozen rows while `totalSteps` still counts them. Keep in sync: frost
styling (`.workflows-step.frozen`, `--freeze*` tokens), snowflake badge during a
run, the saved list's "N frozen" chip, and Run/Queue disabled with "Every step
is frozen" (the backend refuses an all-frozen run anyway). Frost overlays are
`pointer-events: none` so frozen rows stay editable and accept drops.

## Quick-add drag and drop

Chips keep click-to-append and can also be dropped before/between/after steps.
`useQuickAddDragDrop.ts` owns its own `application/x-lattice-workflow-quick-add`
copy payload (row reorder keeps the separate step MIME): insertion index from
row midpoints (covering gaps and the Add-step area), recomputed on drop, marker
cleared on leave/drop/dragend. Payloads carry only an id; the panel resolves the
project-tailored prompt and calls the **same add action as a click**, with an
optional insertion index.

## Parallel reviews

Agent rows only (not Start / Merge / Run tests / Push) have a branching toggle
(`parallel: true`, `aria-pressed`). Adjacent marked rows share a connector and
label (`--workflow-parallel*` tokens); an isolated marked row has none. Frozen
marked rows stay in their group (dimmed connector); frozen unmarked rows and
action steps split groups. Live progress counts completed runnable members, not
the anchor index; a sibling's pre-run tool progress is retained until that
member spawns or completes.

## Styles

`styles/workflows.css` is the ordered aggregator of `styles/workflows/*`
partials; the order is the cascade, so add a partial at its intended spot.

Tests: named after the module in `frontend/src/__tests__/`; editor-lifetime
regressions are in `workflowEditorLifetime.test.ts`, Run tests summaries in
`runTestsStep.test.ts`.
