# backend/src/routes

One Express `Router` per domain. Every module exports a `buildXRouter(...)`
factory and `server/app.ts` mounts them in this order: health, search,
settings, globalSettings, mcp, projectInit, terminals, terminalTabs, tasks,
agentActivity, projectClaude, mergeRuns, postMergeHooks, pushRuns, qaRuns,
workflows.

## Route map

- `health.ts` — composes `routes/health/`: liveness/default-root/harnesses,
  scan + agent-facing dead-code summary, git history/branch, and folder-picker
  browse/create-dir endpoints.
  `health/scan.ts` shares scans across HTTP subscribers and observes unfinished
  response `close` for disconnects. Incoming request `close` is not a reliable
  disconnect signal: a fully consumed GET can emit it while its response waits.
- `search.ts` — `/api/search` file-content grep (rg fast path, JS fallback).
- `settings.ts` — per-project settings, project env notes, instruction
  templates, Pi model menu, and Pi endpoint probing.
- `globalSettings.ts` — `/api/global-settings` machine-global PATCH/GET;
  applies spawn softCap live and reconciles Pi providers when changed.
- `mcp.ts` — MCP catalog, secrets, env presence, validation, and config import.
- `projectInit.ts` — `POST /api/project-init/preview` (what a first commit
  would capture, re-POSTed as the user edits the `.gitignore`) and
  `POST /api/project-init` (`git init` + first commit). Thin: validation plus
  the `ProjectInitError.code` → 409/422/500/503 mapping; the work lives in
  `projectInit/`. Both paths are static, so mount order is unconstrained.
- `terminalTabs.ts` — the durable terminal-tab registry's surface
  (`backend/src/terminalRegistry/`): `GET /api/terminal-tabs` (records),
  `POST /api/terminal-tabs/restore` (adopt / relaunch on project open),
  `PATCH /api/terminal-tabs` (order), `PATCH /api/terminal-tabs/:id` (label),
  `DELETE /api/terminal-tabs/:id` (close: end the record, kill the pty). All
  `?project=`-scoped. Static paths, so mount order is unconstrained.
- `terminals.ts` — terminal list (debug) + `DELETE /api/terminals/:id`, plus
  **`POST /api/terminals`**: pre-create a pty via `proxyCreateSession` and return
  its `serverId`, so a sidebar-launched harness terminal joins the same spawn
  chokepoint (`resolveHarnessSpawnBody`) as tasks and gets its Codex/Pi MCP config
  applied (a serverless `/ws/terminal` connect would bypass it). Debug
  spawn-queue snapshot too.
- `tasks.ts` — task CRUD/list/summary/search/projects, markdown batch/upsert,
  bulk-update, transition, reorder, append-summary, run/resume/merge, worktree
  hook callbacks (`complete`/`merged`/`merge-aborted`/`stash-resolved`), task
  activity hooks, and worktree-modified reads. Submodules under `tasks/` own the
  details; keep path-specific routes (`/summary`, `/search`, `/transition`, …)
  before `/api/tasks/:id`. The list/summary/search reads are the agent-facing
  progressive-disclosure surface (active-lane + compact + newest-100 defaults,
  self-pricing envelopes, 256 KB ceiling → 413) — see `tasks/listQuery.ts` and
  `tasks/taskSearch.ts`.
- `agentActivity.ts` — `/api/agent-activity/:token` for Lattice-spawned
  non-worktree Claude sessions (push/workflow/post-merge) and graph beams.
- `projectClaude.ts` — project-root instrumentation install/remove plus
  `/api/project-activity/:token` for user-started Claude sessions.
- `mergeRuns.ts` — merge-all start/active/get/cancel/stash-resolved.
- `postMergeHooks.ts` — active/recent hook read, completion callback, abort.
- `pushRuns.ts` — git-check plus push-run start/status/done/forget. `/api/git-check`
  also returns the additive `git: ProjectGitProbe` for the Git Setup chip;
  `hasGit` keeps its exact `fs.stat(<path>/.git)` semantics, since the Push
  button reads it and must not start appearing for subdirectories of repos.
- `qaRuns.ts` — QA e2e run start/status/verdict/done/forget.
- `workflows.ts` — workflow definition CRUD, workflow-run start/cancel/
  step-complete/active, and prompt-customization start/status/complete.

## Why factories?

Routes need `BACKEND_ORIGIN` (for generated curl callbacks in hooks/prompts)
which is computed by `server/config.ts` and passed from `server/app.ts`. Passing
it in keeps routers testable and avoids hidden globals.

## Adding a route

1. Add a handler to the right module (or create a new `buildXRouter`).
2. Mount new routers from `server/app.ts` in an order that cannot shadow static
   paths with parameter routes.
3. Errors thrown synchronously or from async handlers are caught by the global
   JSON error middleware in `server/app.ts` (`express-async-errors`).
