# backend/src/routes

One Express `Router` per domain. Each module exports a `buildXRouter(deps)` factory; `server/app.ts` mounts them all.

## Modules

- `health.ts` — `/api/health`, `/api/default-root`, `/api/scan`, `/api/health/dead-code` (agent-facing dead-file list via `../deadCode.ts`, 60s-memoized scan), `/api/list-dir` (read-only).
- `search.ts` — `/api/search` (file-*contents* grep via `../search.ts`; gitignore-aware, size/binary guards, cancel-on-client-close). Uses a ripgrep fast-path (`../ripgrep.ts`) when `rg` is found, falling back to a concurrency-limited Node read loop. Backs the graph search bar's contents pass; returned paths == graph file-node ids. Env knobs: `LATTICE_DISABLE_RG=1` forces the JS path, `LATTICE_RG_PATH=` points at a specific `rg`.
- `settings.ts` — `/api/settings` (per-project user settings) + `/api/project-env` (read-only: auto-detected package-manager envs + the "fresh worktree, don't reinstall" notes that get prepended to `LATTICE_TASK.md`; see `worktree/envDetect.ts`) + `/api/instruction-templates` + `/api/pi-models` (Pi model list + curated dropdown menu; machine-global, reads `globalSettings.piModelMenu`; see `../piModels.ts`).
- `mcp.ts` — MCP control plane (`/api/mcp-catalog`, `/api/mcp-secrets` GET/PATCH, `/api/mcp-env-presence`, `/api/mcp/validate`, `/api/mcp-import/scan`, `/api/mcp-import`). Backs the Settings → MCP tab. Catalog defs / per-project enables flow through the global/user settings routes; this router owns only what must stay off those paths — secret presence (never values), ambient detection, validation, and config import. See `../mcp/CLAUDE.md`.
- `terminals.ts` — `/api/terminals` list/delete (proxies to terminal-server).
- `tasks.ts` — task CRUD + `/run`, `/resume`, `/complete`, `/merge`, `/merged`, `/merge-aborted`, `/stash-resolved`, plus `/activity` (Claude tool-hook callback → `task-activity` WS) and `/worktree-modified` (files changed per not-yet-merged task, for the graph `W` highlight). The state-machine logic lives in `tasks/`. The activity sub-router (`tasks/activity.ts`) mounts first so `GET /api/tasks/worktree-modified` isn't captured by crud's `/api/tasks/:id`. `tasks/colorSlot.ts` assigns the persistent per-task palette slot.
- `mergeRuns.ts` — `/api/merge-runs` start / active / get / cancel / stash-resolved.
- `workflows.ts` — workflow CRUD + `/run` + `/api/workflow-runs/active`, plus workflow prompt-customization start/status/callback endpoints.

## Why factories?

Routes need `BACKEND_ORIGIN` (for the curl callback in worktree Stop hooks) which is computed by `server/config.ts` and passed through `server/app.ts`. Passing it in keeps the router pure-ish and avoids a global.

## Adding a route

1. Add a handler to the right module (or create a new one if none fit).
2. If new module: export a `buildXRouter()` and `app.use(buildXRouter(...))` from `server/app.ts`.
3. Errors thrown synchronously OR from async handlers are caught by the global error middleware in `server/app.ts` (express-async-errors patch). Always responds `{error: ...}` JSON.
