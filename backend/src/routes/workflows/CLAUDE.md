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
  harness/Pi-model override; **409** `active-run-exists` while another run is
  active for the project — one at a time), `POST /api/workflow-runs/:runId/steps/:n/complete`
  (the Stop-hook callback that **advances** the run — runs are driven by this, not
  by watching task state), `cancel`, and `GET /api/workflow-runs/active`.
- `promptCustomizations.ts` — tailor a step prompt before running:
  `POST /api/workflow-prompt-customizations` (spawn the selected harness),
  `GET …/:id` (poll status/result), and `POST …/:id/complete` (harness callback).

## Project pin

`PATCH`/`DELETE /api/workflows/:id` and `POST /api/workflow-runs/:runId/cancel`
look their record up globally, so they honour an optional `?project=` via
`../projectParam.ts` `requireOwnedByRequestedProject` (the same canonical-path
compare as the tasks routes' `requireTaskInRequestedProject`): a non-empty
project that doesn't own the workflow/run is a 404 with a "different board"
hint, before any write. Absent/empty → unpinned, as before. Pinned by
`__tests__/workflowProjectPin.test.ts`.

## Stability

The Stop-hook callback paths/shapes are part of the agent contract — don't change
them when refactoring. Both `runs.ts` and `promptCustomizations.ts` take
`backendOrigin` (for the curl callback baked into the spawned session).
