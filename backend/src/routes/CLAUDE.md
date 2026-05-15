# backend/src/routes

One Express `Router` per domain. Each module exports a `buildXRouter(deps)` factory; `server/app.ts` mounts them all.

## Modules

- `health.ts` — `/api/health`, `/api/default-root`, `/api/scan`, `/api/list-dir` (read-only).
- `settings.ts` — `/api/settings` (per-project user settings) + `/api/project-env` (read-only: auto-detected package-manager envs + the "fresh worktree, don't reinstall" notes that get prepended to `LATTICE_TASK.md`; see `worktree/envDetect.ts`).
- `terminals.ts` — `/api/terminals` list/delete (proxies to terminal-server).
- `tasks.ts` — task CRUD + `/run`, `/resume`, `/complete`, `/merge`, `/merged`, `/merge-aborted`, `/stash-resolved`. The state-machine logic lives here.
- `mergeRuns.ts` — `/api/merge-runs` start / active / get / cancel / stash-resolved.
- `workflows.ts` — workflow CRUD + `/run` + `/api/workflow-runs/active`, plus workflow prompt-customization start/status/callback endpoints.

## Why factories?

Routes need `BACKEND_ORIGIN` (for the curl callback in worktree Stop hooks) which is computed by `server/config.ts` and passed through `server/app.ts`. Passing it in keeps the router pure-ish and avoids a global.

## Adding a route

1. Add a handler to the right module (or create a new one if none fit).
2. If new module: export a `buildXRouter()` and `app.use(buildXRouter(...))` from `server/app.ts`.
3. Errors thrown synchronously OR from async handlers are caught by the global error middleware in `server/app.ts` (express-async-errors patch). Always responds `{error: ...}` JSON.
