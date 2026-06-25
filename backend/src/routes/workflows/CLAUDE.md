# backend/src/routes/workflows

The HTTP edges of the workflow subsystem. `routes/workflows.ts` composes these
three per-concern sub-routers (paths are all distinct, so mount order is not
significant). Run state itself lives in `../../workflowRuns.ts` /
`../../workflowPromptCustomizations.ts`; these modules are thin handlers over it.

## Modules

- `crud.ts` — workflow-**definition** CRUD: `GET`/`POST /api/workflows`,
  `PATCH`/`DELETE /api/workflows/:id`. Backed by `../../workflows.ts`. No run
  state.
- `runs.ts` — run lifecycle: `POST /api/workflows/:id/run` (start, with optional
  harness/Pi-model override), `POST /api/workflow-runs/:runId/steps/:n/complete`
  (the Stop-hook callback that **advances** the run — runs are driven by this, not
  by watching task state), `cancel`, and `GET /api/workflow-runs/active`.
- `promptCustomizations.ts` — tailor a step prompt before running:
  `POST /api/workflow-prompt-customizations` (spawn the selected harness),
  `GET …/:id` (poll status/result), and `POST …/:id/complete` (harness callback).

## Stability

The Stop-hook callback paths/shapes are part of the agent contract — don't change
them when refactoring. Both `runs.ts` and `promptCustomizations.ts` take
`backendOrigin` (for the curl callback baked into the spawned session).
