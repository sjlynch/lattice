# backend/src/workflows

Workflow **definitions** subsystem — CRUD/persistence + field coercion for the
authored workflow templates. This is the *editor-side* model; the *runtime*
that actually executes a run lives in the sibling `../workflowRuns/`. Public
surface re-exports from `../workflows.ts`.

## Modules

- `types.ts` — `Workflow` / `WorkflowStep` / `WorkflowVariable` shapes and the
  `WorkflowStepKind` (`agent` | `start` | `merge` | `push`) / `*Harness`
  enums. Control-flow kinds ignore `prompt`/`harness` at run time; the fields
  are retained on disk for schema uniformity.
- `store.ts` — `WorkflowStore extends ProjectStateManager<Workflow[]>`:
  list/get/create/update/delete with debounced persistence and per-project
  subscriber fan-out. Unlike tasks (which moved to `~/.lattice/`),
  `workflows.json` still lives **in-project** at `<project>/.lattice/`. By-id
  ops use `withWorkflowAcrossProjects` (cache → `loadAllKnown` fallback) so a
  lookup resolves even for an unopened project after a backend restart.
- `normalization.ts` — defensive coercion of untrusted disk/HTTP input into the
  types above. **Invariant:** `ensureUserInstructions` guarantees every
  workflow always carries the built-in `user_instructions` variable (leading
  the list). Variable names are coerced to the `[A-Za-z0-9_]` token grammar.
- `interpolate.ts` — `interpolateWorkflowVariables`: substitutes `{{name}}`
  refs in a step prompt with the workflow's variable values, called from
  `workflowRuns/stepMarkdown.ts` before the prompt reaches the agent. Unknown
  refs are left intact so a `{{typo}}` stays visible. The `{{…}}` grammar must
  stay in sync with `normalizeVariableName`.
