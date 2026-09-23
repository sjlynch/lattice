# backend/src/workflows

Workflow **definitions** subsystem — CRUD/persistence + field coercion for the
authored workflow templates. This is the *editor-side* model; the *runtime*
that actually executes a run (advancing step→step) lives in the sibling
`../workflowRuns/`. `../workflows.ts` is the public facade — every consumer
imports from `'../workflows.js'`; this directory holds the implementation.

## Modules

- `types.ts` — `Workflow` / `WorkflowStep` / `WorkflowVariable` /
  `WorkflowSubscriber` shapes and the `WorkflowStepKind` (`agent` | `start` |
  `merge` | `push` | `test`) / harness enums. `test` is the **Run tests**
  step: an agent step with a fixed brief (it ignores `prompt`, uses `harness` /
  `piModel`) plus `timeoutMinutes` (default 60, normalized to an integer in
  [5, 720], stripped from every other kind) — see `../workflowRuns/CLAUDE.md`
  (`testStep/`). A kind missing from `STEP_KINDS` in `normalization.ts`
  silently becomes `agent`, so a new kind must be added there too. The legacy per-step `mode`
  (`sequential` | `parallel`) is gone — nothing ever read it; it stays optional
  on the type only so pre-removal data type-checks, and `normalizeSteps` strips
  it. The control-flow kinds
  (`start`/`merge`/`push`) ignore `prompt`/`harness` at run time and are
  executed directly against the task pipeline; only `agent` steps spawn a
  harness. The fields are retained on disk for schema uniformity. `frozen`
  (the editor's snowflake toggle) is kind-agnostic: the step stays in the
  definition but the run engine skips it — see
  `../workflowRuns/frozenSteps.ts`. `tools` (`WorkflowStepTool[]`, v1 only
  `opengrep` — set by the "Opengrep" quick-add chip / template, shown as a
  read-only shield badge, no per-step toggle) names the pre-run tools an
  agent step runs before its harness spawns; see `../workflowRuns/stepTools.ts`.
- `normalization.ts` — defensive coercion of untrusted disk/HTTP input into the
  types above (`normalizeWorkflows` / `normalizeSteps` / `normalizeVariables`
  + name/harness helpers). `frozen` is coerced to `true` or `undefined` (never
  `false`), so the flag stays out of the JSON for the common case — same shape
  convention as `piModel`; `tools` likewise (`normalizeStepTools`: known ids
  only, deduplicated, `undefined` when empty). **Invariant:** every workflow's
  `projectPath` is the project that OWNS the `workflows.json`
  (`normalizeWorkflows(raw, projectPath)`), never the path embedded in the
  record — a copied/moved project keeps the old absolute path in its file, and
  honouring it made its workflows merge into / push from the ORIGINAL repo.
  **Invariant:** `ensureUserInstructions` guarantees
  every workflow always carries the built-in `user_instructions` variable
  (`USER_INSTRUCTIONS_VAR`, leading the list). Variable names are coerced to the
  `[A-Za-z0-9_]` token grammar.
- `defaultPromptMigrations.ts` — upgrades stale copies of **Lattice's own**
  built-in step prompts (the quick-add chips in
  `frontend/src/components/workflows/prompts/*.md` and the built-in workflow
  templates). A saved workflow holds a plain *copy* of whatever prompt text the
  editor produced, so rewording a shipped prompt never reaches an
  already-saved workflow on its own. Entries carry the previously-shipped bodies
  (`legacy`, newest first, lifted byte-exact from git) and the `current` one;
  matching is a **prefix** test so the editor's appended
  `{{user_instructions}}` / "## Active project tailoring" suffix survives, and a
  hand-edited prompt matches nothing and is left alone. Applied by `store.ts` —
  once per project on first load (persisted + fanned out to subscribers) and
  again on create/update (a browser tab on an older bundle still inserts the old
  text). Exists because several built-ins used to end in "commit your work",
  contradicting `WORKFLOW_STEP.md`'s planner-only contract; an agent resolved the
  contradiction by committing code straight from a workflow step. **Reword a
  built-in → append the old body to that entry's `legacy` and update `current`**;
  `__tests__/defaultPromptMigrations.test.ts` pins `current` against the frontend
  markdown so the two copies can't drift. The tailoring block's guidance bullets
  (frontend `projectStackDetection.ts`) sit in that verbatim-kept suffix, so a
  reworded bullet gets an exact-line entry in `DEFAULT_PROMPT_LINE_MIGRATIONS`
  instead (applies to any step's prompt; pinned by
  `__tests__/defaultPromptLineMigrations.test.ts`).
- `interpolate.ts` — `interpolateWorkflowVariables`: substitutes `{{name}}`
  refs in a step prompt with the workflow's variable values, called from
  `workflowRuns/stepMarkdown.ts` before the prompt reaches the agent. Unknown
  refs are left intact so a `{{typo}}` stays visible. `WORKFLOW_VARIABLE_PATTERN`
  is the shared `{{ident}}` grammar (must stay in sync with
  `normalizeVariableName`).
- `store.ts` — `WorkflowStore extends ProjectStateManager<Workflow[]>`:
  list/get/create/update/delete with debounced persistence and per-project
  `(projectPath, workflows)` subscriber fan-out. Unlike tasks (which moved to
  `~/.lattice/`), `workflows.json` still lives **in-project** at
  `<project>/.lattice/` (`WORKFLOWS_FILENAME` / `workflowsFile` here). Read-only
  by-id ops use `withWorkflowAcrossProjects` (cache → `loadAllKnown` fallback) so
  a lookup resolves even for an unopened project after a backend restart;
  mutating ops (create/update/delete) run under the base's per-project write lock
  (create via `runProjectWrite`, update/delete via `withLockedItemAcrossProjects`)
  so two concurrent edits can't clobber via a read-before-write race. The base
  also gives this store atomic temp→rename writes + the corrupt-load guard for
  free (see `taskCache/CLAUDE.md` "Crash-safety contract"); its `deserialize`
  throws on a file that parses but is not an array (`{}`, `null`, a wrapper
  object) so that too is preserved to a `.corrupt-*` sidecar instead of loading
  as `[]` and being overwritten by the next save (mirrors
  `taskCache/manager.ts`). It overrides
  `loadIfNeeded` to run `defaultPromptMigrations` once per project after the
  disk read; keep that override cheap and idempotent (it runs inside every
  cache-miss path, including `loadAllKnown`).

## Served by

`routes/workflows/crud.ts` (definition CRUD). Tests:
`__tests__/workflows.test.ts`, `__tests__/projectStateManager.test.ts` — both
import via `'../workflows.js'`.
