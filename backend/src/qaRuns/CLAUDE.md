# backend/src/qaRuns

QA-lane "run an end-to-end test" sessions (per-task ▶ and lane-wide, shown when
the `qaPlaywright` toggle is on). A one-off Playwright-enabled Claude session
spawns from home-scoped scratch, `cd`s into the project, drives the merged
feature end-to-end with the Playwright browser tools, appends a human-readable
PASS/FAIL to the task via `/append-summary`, then posts a *structured* verdict
to `POST /api/qa-runs/:id/verdict` before stopping. `../qaRuns.ts` is the public
shim; served by `routes/qaRuns.ts`.

## Mirror of `pushRuns/`

Same skeleton (`paths` / `cleanup` / `session` / `stopHook` / `instructions` /
`registry` / `types`) with the same in-memory-registry, home-scoped-scratch
(`~/.lattice/per-project/<hash>/qa/<id>/`, **outside** the repo), path-guard and
boot-sweep (`recovery/qaSessionSweep.ts → sweepOrphanedQaSessions`) contract.
**See `pushRuns/CLAUDE.md` for that shared shape** — including that the registry
is non-persisted (stale-at-boot ⇒ swept) and that the path guards here
(`assertSafeQaSessionPath` / `isPathInsideOrSame`) are part of the repo's
`.git`-deletion defence layer a third run-type must replicate. **Edit one,
check the other.**

Differences from pushRuns:

- **`verdict.ts` (qaRuns-only).** `applyQaVerdict` records the agent's verdict
  and, on a **confident PASS**, auto-advances the task `qa → done` (guarded:
  only when the task is still in the `qa` lane); a FAIL or an unsure PASS leaves
  it for a human. pushRuns has no `verdict.ts` — its `/done` Stop callback is
  pure cleanup. The verdict is posted *before* the session stops so it lands
  while the run is still tracked.
- **Spawn sets `isQaRun: true`** so the MCP injection chokepoint adds the
  QA-scoped Playwright (with the lane's headed/headless choice); ordinary task
  spawns never set it.
- **`forgetQaRun` never drops a still-`running` run.** The frontend poller
  calls it (via `DELETE /api/qa-runs/:id`) on any transient `GET :id` hiccup,
  and evicting a live run before its `/verdict` lands silently breaks the
  qa → done auto-advance (the bug that left passed tasks stuck in QA). Only
  `done` runs are forgotten.
