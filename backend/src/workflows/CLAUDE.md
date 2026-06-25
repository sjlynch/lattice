# backend/src/workflows

Persistent workflow **definitions** per project (an ordered chain of prompt
steps). `../workflows.ts` is the public facade — every consumer imports from
`'../workflows.js'`; this directory holds the implementation. Workflow **run
state** (advancing step→step) is a different subsystem — see `../workflowRuns/`.

## Modules

- `types.ts` — the shape: `Workflow` / `WorkflowStep` / `WorkflowVariable` /
  `WorkflowSubscriber` and the step `kind` (`agent` | `start` | `merge` | `push`)
  / `mode` / harness enums. The control-flow kinds (`start`/`merge`/`push`) are
  executed directly against the task pipeline; only `agent` steps spawn a harness.
- `normalization.ts` — defensive parse of on-disk / API-supplied data into the
  `types.ts` shapes: `normalizeWorkflows` / `normalizeSteps` / `normalizeVariables`
  (+ name/harness helpers). `ensureUserInstructions` guarantees every workflow
  carries the built-in `user_instructions` variable (`USER_INSTRUCTIONS_VAR`).
- `interpolate.ts` — `interpolateWorkflowVariables` substitutes `{{name}}` refs
  in a step prompt with the workflow's variable values (called from
  `workflowRuns/stepMarkdown.ts` before the prompt reaches the agent). Unknown
  refs are left intact so a typo stays visible. `WORKFLOW_VARIABLE_PATTERN` is the
  shared `{{ident}}` grammar (matches `normalizeVariableName`).
- `store.ts` — `WorkflowStore` over `ProjectStateManager`: canonical-project
  cache, lazy disk load of `<project>/.lattice/workflows.json`, debounced
  persistence, by-id cross-project lookup, and `(projectPath, workflows)`
  subscriber fan-out. `WORKFLOWS_FILENAME` / `workflowsFile` live here.

## Served by

`routes/workflows/crud.ts` (definition CRUD). Tests: `__tests__/workflows.test.ts`,
`__tests__/projectStateManager.test.ts` — both import via `'../workflows.js'`.
