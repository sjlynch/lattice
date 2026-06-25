# backend/src/workflows

Workflow **definitions** subsystem — CRUD/persistence + field coercion for the
authored workflow templates. This is the *editor-side* model; the *runtime*
that actually executes a run (advancing step→step) lives in the sibling
`../workflowRuns/`. `../workflows.ts` is the public facade — every consumer
imports from `'../workflows.js'`; this directory holds the implementation.

## Modules

- `types.ts` — `Workflow` / `WorkflowStep` / `WorkflowVariable` /
  `WorkflowSubscriber` shapes and the `WorkflowStepKind` (`agent` | `start` |
  `merge` | `push`) / `mode` / harness enums. The control-flow kinds
  (`start`/`merge`/`push`) ignore `prompt`/`harness` at run time and are
  executed directly against the task pipeline; only `agent` steps spawn a
  harness. The fields are retained on disk for schema uniformity.
- `normalization.ts` — defensive coercion of untrusted disk/HTTP input into the
  types above (`normalizeWorkflows` / `normalizeSteps` / `normalizeVariables`
  + name/harness helpers). **Invariant:** `ensureUserInstructions` guarantees
  every workflow always carries the built-in `user_instructions` variable
  (`USER_INSTRUCTIONS_VAR`, leading the list). Variable names are coerced to the
  `[A-Za-z0-9_]` token grammar.
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
  `<project>/.lattice/` (`WORKFLOWS_FILENAME` / `workflowsFile` here). By-id ops
  use `withWorkflowAcrossProjects` (cache → `loadAllKnown` fallback) so a lookup
  resolves even for an unopened project after a backend restart.

## Served by

`routes/workflows/crud.ts` (definition CRUD). Tests:
`__tests__/workflows.test.ts`, `__tests__/projectStateManager.test.ts` — both
import via `'../workflows.js'`.
