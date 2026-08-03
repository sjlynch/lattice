# backend/src/instructionTemplates

The editable agent-instruction template subsystem. Every brief Lattice writes
for a spawned agent (`LATTICE_TASK.md`, `MERGE_INSTRUCTIONS.md`, and the QA /
push / post-merge / workflow-step briefs) is a markdown **template** with
`{{token}}` placeholders for its dynamic parts. Users can override any template
per project in Settings → Agent prompts; a missing/blank override falls back to
the built-in default. `../instructionTemplates.ts` is the public shim.

## Modules

- `apply.ts` — `applyTemplate(template, values)`: the one substitution engine.
  Single pass over the **template** only (`{{token}}` → value); replacement
  text is never re-scanned (a value containing `{{…}}`, e.g. a workflow step
  prompt with an unresolved variable, survives). Unknown tokens are left
  verbatim so a typo stays visible.
- `templates/` — one **leaf module per template** holding just that template's
  long `DEFAULT_*_TEMPLATE` markdown string (`task.ts`, `merge.ts`, `qa.ts`,
  `push.ts`, `postMergeHook.ts`, `workflowStep.ts`). Each imports nothing; the
  body is the only export.
- `defs.ts` — **leaf catalog**: re-exports the `DEFAULT_*_TEMPLATE` strings from
  `templates/` (so existing `defs.js` import paths still resolve) and assembles
  `INSTRUCTION_TEMPLATE_CATALOG` (id / title / filename / description /
  defaultTemplate / token docs) plus the shared types. Imports nothing from the
  renderers or the resolver, so both can import the defaults from here without a
  cycle.
- `resolve.ts` — `resolveInstructionTemplate(projectPath, id)`: the project's
  override (`UserSettings.instructionTemplateOverrides[id]`) if present **and
  non-empty**, else the default. The non-empty guard is a safety net — a blank
  override would otherwise wipe the instruction file.
- `editorData.ts` — `buildInstructionTemplateEditorData(project)`: the
  per-project payload for the settings editor (default + current + token docs).
  Backs `GET /api/instruction-templates`.

## How a renderer uses it

Each renderer (e.g. `worktree/instructions/taskPrompt.ts`,
`workflowRuns/stepMarkdown.ts`) imports its `DEFAULT_*_TEMPLATE` from `defs.ts`
and `applyTemplate` from `apply.ts`. It computes the token values — including
the conditional/computed blocks (autonomy preamble, env-notes block, dead-code
note, dirty-state warning, completion instructions, …), which are themselves
tokens — and returns `applyTemplate(template, values)`. The renderers stay
**synchronous**; the resolved template is passed in as the last (optional,
default = the built-in) argument. The **spawn callers** (`setupFiles.ts`,
`qaRuns/session.ts`, `pushRuns/session.ts`, `postMergeHooks/sessionSetup.ts`,
`workflowRuns/stepSpawner.ts`, and `writeMergeInstructions` itself) do the
`await resolveInstructionTemplate(project, id)` and pass the result in.

## Adding / changing a template

1. Edit the `DEFAULT_*_TEMPLATE` in its `templates/<name>.ts` leaf module (or
   add a new leaf module + re-export it from `defs.ts` + a catalog entry with
   its token docs + a new `InstructionTemplateId`).
2. Keep the token set in sync between the catalog entry and the renderer's
   `applyTemplate` values map — an unknown token renders verbatim (visible bug),
   a value with no token in the template is silently dropped.
3. Avoid an import cycle: defaults live in `defs.ts` (leaf); renderers import
   from `defs.ts`/`apply.ts` only — never from `resolve.ts`/`editorData.ts`.

## Invariants

- A blank/whitespace-only override is ignored (falls back to the default).
- **A project override freezes that template.** Migrations only reach the
  built-in defaults, so a user who overrode `workflow-step` keeps their own
  wording — including any contradiction they wrote into it. Worth knowing when
  debugging "the agent ignored the brief".
- `workflow-step`'s planner-only section must stay **above** `{{step_prompt}}`
  and keep claiming precedence over it; see `../workflowRuns/CLAUDE.md`.
