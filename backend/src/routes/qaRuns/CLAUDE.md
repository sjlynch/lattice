# backend/src/routes/qaRuns

Helpers behind `../qaRuns.ts`, the QA e2e run routes (start / status /
verdict / done / forget). Route wiring only — the run lifecycle lives in
`../../qaRuns.ts` + `../../qaRuns/` (see its CLAUDE.md).

- `responses.ts` — picks exactly the fields the frontend reads off
  `POST /api/qa-runs` and the polled `GET /api/qa-runs/:id`
  (`frontend/src/components/taskboard/hooks/useQaRuns.ts`). **Load-bearing
  shapes; don't let them drift** — change both sides together.
- `startGuard.ts` — `resolveQaRunStart` (body validation, task belongs to the
  project, status `qa`) returns `{ok:false, status, error}` /
  `{ok:true, project, task}`, which the route maps straight onto HTTP.
  `findActiveQaRunForTask` is the **duplicate-run guard** (409, together with
  the route's in-flight `starting` set): two Playwright sessions for one task
  each post a verdict, and either confident PASS promotes it.
- `verdictBody.ts` — **deliberately tolerant** verdict parse:
  `{verdict:'pass'|'fail', confidence:'high'|'low'}` or the boolean shorthand
  `passed` / `confident`, so a user-edited QA template's wording drift still
  advances the task. Don't make it strict.
