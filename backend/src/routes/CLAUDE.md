# backend/src/routes

One Express `Router` per domain. Each module exports a `buildXRouter(deps)` factory; `index.ts` mounts them all.

## Modules

- `health.ts` — `/api/health`, `/api/default-root`, `/api/scan`, `/api/list-dir` (read-only).
- `settings.ts` — `/api/settings` (per-project user settings).
- `terminals.ts` — `/api/terminals` list/delete (proxies to terminal-server).
- `tasks.ts` — task CRUD + `/run`, `/resume`, `/complete`, `/merge`, `/merged`, `/merge-aborted`, `/stash-resolved`. The state-machine logic lives here.
- `mergeRuns.ts` — `/api/merge-runs` start / active / get / cancel / stash-resolved.
- `workflows.ts` — workflow CRUD + `/run` + `/api/workflow-runs/active`.

## Why factories?

Routes need `BACKEND_ORIGIN` (for the curl callback in worktree Stop hooks) which is computed in `index.ts`. Passing it in keeps the router pure-ish and avoids a global.

## Adding a route

1. Add a handler to the right module (or create a new one if none fit).
2. If new module: export a `buildXRouter()` and `app.use(buildXRouter(...))` from `index.ts`.
3. Errors thrown synchronously OR from async handlers are caught by the global error middleware in `index.ts` (express-async-errors patch). Always responds `{error: ...}` JSON.
