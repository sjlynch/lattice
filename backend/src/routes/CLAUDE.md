# backend/src/routes

One Express `Router` per domain. Every module exports a `buildXRouter(...)`
factory and `server/app.ts` mounts them in this order: restartDrain
(admission gate, then the internal handshake), health, search,
settings, globalSettings, mcp, opengrep, projectInit, terminals, terminalTabs,
tasks, agentActivity, projectClaude, mergeRuns, postMergeHooks, pushRuns,
qaRuns, workflows.

## Route map

- `restartDrain.ts` — the dev runner's restart handshake
  (`/api/internal/restart-drain/{prepare,cancel,lock-holders}`; refuses any
  `Origin`, requires `x-lattice-terminal-token`) and
  `buildRestartDrainAdmissionGate`, which 503s (`backend-restarting`,
  `Retry-After`) new top-level starts while a drain is on. Must stay mounted
  FIRST so the gate runs before the routes it guards. See
  `../restartDrain/CLAUDE.md`.
- `health.ts` — composes `routes/health/`: `liveness.ts` (liveness/
  default-root/harnesses), `scan.ts` (scan + agent-facing dead-code summary),
  `gitInfo.ts` (`/api/git-history` + `/api/git-branch`), and `browse.ts`
  (folder-picker list-dir/create-dir).
  `health/scan.ts` shares scans across HTTP subscribers and observes unfinished
  response `close` for disconnects. Incoming request `close` is not a reliable
  disconnect signal: a fully consumed GET can emit it while its response waits.
- `search.ts` — `/api/search` file-content grep (rg fast path, JS fallback).
- `settings.ts` — per-project settings, project env notes, instruction
  templates, Pi model menu, and Pi endpoint probing.
- `globalSettings.ts` — `/api/global-settings` machine-global PATCH/GET;
  applies spawn softCap live and reconciles Pi providers when changed.
- `mcp.ts` — MCP catalog, secrets, env presence, validation, and config import.
- `opengrep.ts` — Opengrep (SAST): `GET /api/opengrep/status`, the user-clicked
  `POST /api/opengrep/install` + `POST /api/opengrep/rules/install` /
  `DELETE /api/opengrep/rules/:packId` (202 + poll `/status`), and the
  agent-facing `POST /api/opengrep/scan` + `GET /api/opengrep/scans[/:id]`
  (`latest` allowed; `format=md`, `rule=`/`file=`/`severity=`/`budgetKb=`
  narrow the digest) and `POST /api/opengrep/ignore` (append to the project's
  ignore lists). 409 codes `busy` / `not-installed` / `no-rules`; 400
  `bad-target` for a scan target outside the project. The pack install/remove
  routes also answer 409 `busy` while ANY project's scan is running, since a
  pack swap or delete under a reading engine is a half-swapped tree (or a
  Windows EBUSY). Thin over `../opengrep/` (see its CLAUDE.md);
  project-scoped paths use `readProjectParam`. Static paths, mount order
  unconstrained.
- `projectInit.ts` — `POST /api/project-init/preview` (what a first commit
  would capture, re-POSTed as the user edits the `.gitignore`) and
  `POST /api/project-init` (`git init` + first commit). Thin: validation plus
  the `ProjectInitError.code` → 409/422/500/503 mapping; the work lives in
  `projectInit/`. Both paths are static, so mount order is unconstrained.
- `terminalTabs.ts` — the durable terminal-tab registry's surface
  (`backend/src/terminalRegistry/`): `GET /api/terminal-tabs` (records),
  `POST /api/terminal-tabs/restore` (adopt / relaunch on project open),
  `PATCH /api/terminal-tabs` (order), `PATCH /api/terminal-tabs/:id` (label),
  `DELETE /api/terminal-tabs/:id` (close: end the record, abort a post-merge
  hook owning the pty, kill the pty — same abort as `DELETE /api/terminals/:id`). All
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
- `qaRuns.ts` — QA e2e run start/status/verdict/done/forget. Route wiring over
  `qaRuns/` (lifecycle stays in `../qaRuns.ts` + `../qaRuns/`):
  - `responses.ts` — picks exactly the fields the frontend reads off
    `POST /api/qa-runs` and the polled `GET /api/qa-runs/:id`
    (`frontend/src/components/taskboard/hooks/useQaRuns.ts`). **Load-bearing
    shapes; don't let them drift.**
  - `startGuard.ts` — `resolveQaRunStart` (body validation, task belongs to
    project, status `qa`) returns `{ok:false, status, error}` /
    `{ok:true, project, task}` that the route maps straight onto HTTP;
    `findActiveQaRunForTask` is the **duplicate-run guard** (409, plus the
    route's in-flight `starting` set): two Playwright sessions for one task
    each post a verdict, and either confident PASS promotes it.
  - `verdictBody.ts` — **deliberately tolerant** verdict parse:
    `{verdict:'pass'|'fail', confidence:'high'|'low'}` or the boolean
    shorthand `passed`/`confident`, so a user-edited QA template's wording
    drift still advances the task. Don't make it strict.
- `workflows.ts` — workflow definition CRUD, workflow-run start/cancel/
  step-complete/active, and prompt-customization start/status/complete.

## The `project` parameter

`projectParam.ts` — `readProjectParam(req, res, {source?, optional?})` is the
ONE way a non-task route reads the project it acts on (`?project=` first, then
the body; the tasks routes have their own `requireAbsoluteProject` /
`validateProjectForCreate` with the same rule). It refuses a relative or
drive-relative value with a 400 that names the likely cause (shell-stripped
backslashes: `C:developmentproj`). On Windows it also refuses a ROOT-relative
value (`\foo`, or the MSYS / Git-Bash `/c/development/proj`, whose 400 suggests
the `C:\development\proj` spelling): `path.isAbsolute` accepts those, but
`path.resolve` pins them to the backend's drive, which read as a silently-empty
board. Every guard (these routes, `ws/projectEndpoint.ts` `parseProject`, and
the task cache's index registration in `ensureProjectLoaded`) uses the one
`isRealAbsoluteProjectPath` helper in `../projectPath.ts`, never bare
`path.isAbsolute`. This matters because every per-project
store resolves its path through `canonicalProjectPath` == `path.resolve`, so a
relative project silently landed under the BACKEND's own cwd —
`PATCH /api/settings?project=foo` created `backend/foo/.lattice/
userSettings.json`, and the workflow / terminal-tab / merge-run /
instrumentation / prompt-customization routes did the same for theirs.
`POST /api/terminals` applies the same rule to `cwd` and `projectPath`, and
`POST /api/project-instrumentation` additionally requires the project to be
an existing directory (its reconcile mkdirs `<project>/.claude/`). Always act
on the value `readProjectParam` returns (trimmed), never the raw body field. The read-only graph
routes that take `?path=` (or `?project=`) with a default-root fallback —
`/api/scan`, `/api/search`, `/api/health/dead-code`, `/api/git-history`,
`/api/git-branch` — go through `readPathParam` (same module): absent → the
default root, present-but-relative → the same 400. The WS endpoints apply it
too (`ws/projectEndpoint.ts` `parseProject` yields `''` for a relative
project, which closes the socket). Pinned by
`__tests__/relativeProjectRefused.test.ts`, which drives every project-scoped
route (and `/ws/tasks`) through the real app.

## Why factories?

Routes need `backendOrigin` (for generated curl callbacks in hooks/prompts),
which `server/config.ts` computes and `server/app.ts` threads through
`mountRouteFactories` into each `buildXRouter`. Passing it in keeps routers
testable and avoids hidden globals.

## Adding a route

1. Add a handler to the right module (or create a new `buildXRouter`).
2. Mount new routers from `server/app.ts` in an order that cannot shadow static
   paths with parameter routes.
3. Errors thrown synchronously or from async handlers are caught by the global
   JSON error middleware in `server/app.ts` (`express-async-errors`).
