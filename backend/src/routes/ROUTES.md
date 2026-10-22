# HTTP / WS route map

Every backend route and WebSocket endpoint, one row each. Exhaustive by
contract: `__tests__/latticeApiDocsDrift.test.ts` fails when a mounted route
is missing here or a row names a route that no longer exists, so add the row
in the same change as the route. Per-router detail lives in
[CLAUDE.md](./CLAUDE.md) (this directory) and the route modules; the
agent-facing subset is `../latticeApiDocs/*.template.md`.

## Core

Full per-route detail: the route modules (`backend/src/routes/CLAUDE.md`) and
the agent-facing `backend/src/latticeApiDocs/*.template.md`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness probe |
| GET | `/api/harnesses?refresh=1` | Detected agent CLIs (`claude` / `pi` / `codex`) |
| GET | `/api/default-root` | Default project for the UI |
| GET | `/api/scan?path=` | Recursive source-file scan, gitignore-aware |
| GET | `/api/source-areas?project=&count=` | Split the scanner's production-source files into repository areas → `{areas, totalFiles}`; count integer 2–16 |
| POST | `/api/source-areas/resolve` | Resolve custom editor areas from `{project, areas, includeRest}` ? `{areas, missing, overlaps, rest, totalFiles}` |
| GET | `/api/source-tree?project=` | Production source folder picker ? nested `{path, name, files, weight, children}`; counts and weights are direct files |
| GET | `/api/search?project=&q=&regex=` | File-contents search → `{matches, scanned, truncated}` (abs paths == graph node ids); `*`/`?` wildcards unless `regex=1` |
| GET | `/api/health/dead-code?project=` | Files confidently flagged unreachable (60s-memoized) |
| GET | `/api/git-history?path=&limit=` | Timeline history (`git log --name-status -M`) + `deletedPaths` for ghost nodes |
| GET | `/api/git-branch?path=` | Current branch (one-shot; navbar uses `/ws/git-branch`) |
| GET | `/api/list-dir?path=` | Folder browser |
| POST | `/api/create-dir` | Folder-picker create-directory `{parent, name}` |
| GET | `/api/settings?project=` | Read per-project user settings |
| GET | `/api/spec-gaps?project=&limit=` | Recent implementer Spec gaps for this project (limit 1–100, default 25) |
| PATCH | `/api/settings?project=` | Merge-update per-project user settings |
| GET | `/api/instruction-templates?project=` | Editable agent brief templates (default, current, `{{token}}` docs); saved via PATCH `/api/settings` |
| GET | `/api/harness-system-prompts?project=` | Per-harness system-prompt editor data (default overview + Append/Replace override) |
| GET | `/api/global-settings` | Read machine-global settings |
| PATCH | `/api/global-settings` | Update machine-global settings (softCap applied live; `piProviders` reconciled into models.json) |
| GET | `/api/pi-models` | Pi models + curated "Pi — X" `menu` + Pi's `defaultPattern` |
| GET | `/api/codex-models` | Codex models Codex lists in its own picker (from `~/.codex/models_cache.json`; empty when absent) |
| GET | `/api/plan-usage?refresh=` | Claude + Codex subscription usage: % used per rate-limit window, reset times (cached 60 s; `refresh=1` forces) |
| POST | `/api/pi-endpoints/probe` | `{baseUrl, apiKey?, headers?}` → models an OpenAI-compatible server serves (+ context window) |
| GET | `/api/mcp-catalog` | Merged MCP catalog (definitions only, no secrets) |
| GET | `/api/mcp-secrets` | Redacted MCP secret presence (booleans + last-4 hints) |
| PATCH | `/api/mcp-secrets` | Set/clear one secret `{serverId, envVar, value}` |
| GET | `/api/mcp-env-presence` | Which required MCP env vars exist in the backend env |
| POST | `/api/mcp/validate` | `{serverId}` → run the server's key validator |
| GET | `/api/mcp-import/scan?project=` | Scan other tools' MCP configs (secrets redacted) |
| POST | `/api/mcp-import` | Apply selected imports `{ids, project?}` |
| GET | `/api/opengrep/status?project=` | Engine / install job / rule packs / running scan / last scan |
| POST | `/api/opengrep/install` | Start the managed engine install (`202`, user-clicked only) |
| POST | `/api/opengrep/rules/install` | `{packId}` fetch/update a rule pack (**409** while a scan runs) |
| DELETE | `/api/opengrep/rules/:packId` | Remove a rule pack (**409** while a scan runs) |
| POST | `/api/opengrep/scan` | `{project, targets?, mode?: full/incremental, includeMarkdown?}` run a scan (default full; **409** `busy`/`not-installed`/`no-rules`/`scan-cancelled`/`install-failed`, **400** `bad-target`) |
| POST | `/api/opengrep/scans/:id/cancel` | `{project}` cancel that exact running scan; waits for the engine to settle |
| GET | `/api/opengrep/scans?project=` | Recent scan records |
| GET | `/api/opengrep/scans/:id?project=&format=md&…` | One scan (`latest` ok) as the filtered agent digest; `format=graph` gives complete findings, per-file severity/coverage and freshness |
| POST | `/api/opengrep/ignore` | `{project, ruleIds?, fingerprints?}` append to the project's Opengrep ignore lists |
| GET | `/api/project-env?project=` | Detected package-manager envs + "don't reinstall" notes |
| GET | `/api/projects` | Known project roots + hashes |
| POST | `/api/project-init/preview` | `{project, gitignore?}` → what a first commit would capture |
| POST | `/api/project-init` | `git init -b main` + `.gitignore` + first commit (`409`/`422`/`500`/`503`; see `backend/src/projectInit/`) |
| GET | `/api/tasks?project=&status=&ids=&fields=&clip=&since=&limit=&format=&confirm_large=` | List tasks — progressive-disclosure defaults (active lanes, compact, clipped, newest 100; **413** over 256 KB). See `routes/tasks/listQuery.ts` |
| GET | `/api/tasks/summary?project=` | Counts + per-lane cost, under 1 KB — the intended FIRST call for an agent |
| GET | `/api/tasks/search?project=&q=&status=&limit=` | AND-of-terms task search with snippets (default `status=all`) |
| GET | `/api/tasks/worktree-modified?project=` | Files changed by each unmerged task (graph `W` overlay) |
| GET | `/api/tasks/:id` | Fetch a single task |
| POST | `/api/tasks` | Create `{project, title, description?}` |
| POST | `/api/tasks/batch` | Batch-create (JSON or `text/markdown` `# Heading` blocks) |
| POST | `/api/tasks/bulk-update` | Apply multiple `{id, patch}` updates |
| POST | `/api/tasks/upsert` | Upsert from markdown/JSON (`{id=...}` headings update) |
| POST | `/api/tasks/transition` | Bulk status transition by `ids` or `{fromStatus, project}` |
| PATCH | `/api/tasks/:id` | Update `title` / `description` / `status` (JSON or markdown body) |
| POST | `/api/tasks/reorder` | Persist per-lane order `{project, status, ids}` |
| POST | `/api/tasks/:id/append-summary` | Append a summary beneath the description |
| DELETE | `/api/tasks/:id` | Remove + tear down worktree; a branch with unmerged commits is kept (`keptBranch`) |
| POST | `/api/tasks/:id/cancel-queued-run` | Drop a queued run back to plain Open |
| POST | `/api/tasks/:id/run` | Enqueue a run → `{accepted, queued}` (pty via `task-spawned` WS) |
| POST | `/api/tasks/:id/resume` | Enqueue a re-spawn in the existing worktree → `{accepted, queued}` |
| POST | `/api/tasks/:id/complete` | Stop-hook callback (optional second opinion before in_progress → ready_to_merge; resolvers finalize directly) |
| POST | `/api/tasks/:id/activity` | Worktree agent tool-use / subagent hook → `task-activity` WS (graph beams) |
| POST | `/api/agent-activity/:token` | Same, for a non-worktree session (push / workflow step / post-merge hook) |
| POST | `/api/project-instrumentation` | `{project}` install/remove activity hooks in the project's `.claude/settings.local.json` |
| POST | `/api/project-activity/:token` | Hook callback for any project-instrumented session, keyed by `session_id` |
| POST | `/api/tasks/:id/merge` | Attempt merge; conflict pre-creates resolver pty, returns `serverId` |
| POST | `/api/tasks/:id/merged` | Resolver callback after a successful merge |
| POST | `/api/tasks/:id/merge-aborted` | Resolver callback if it gave up |
| POST | `/api/tasks/:id/stash-resolved` | Snapshot-conflict resolver callback |
| POST | `/api/merge-runs` | Body `{project}` — start a merge-all run |
| GET | `/api/merge-runs/active?project=` | Active run for a project, or `null` |
| GET | `/api/merge-runs/recovery?project=` | Persisted recovery attempts and pause reasons |
| GET | `/api/merge-runs/:id` | Run snapshot |
| POST | `/api/merge-runs/:id/cancel` | Request cancellation (finishes current task) |
| POST | `/api/merge-runs/:id/stash-resolved` | Post-run snapshot-conflict resolver callback |
| GET | `/api/workflows?project=` | List workflow definitions |
| POST | `/api/workflows` | Create a workflow definition |
| PATCH | `/api/workflows/:id` | Update (optional `?project=` pin → 404 cross-project) |
| DELETE | `/api/workflows/:id` | Delete (optional `?project=` pin) |
| POST | `/api/workflows/:id/run` | Start a run; one per project (**409** `active-run-exists`); optional `?project=` pin → 404 cross-project |
| POST | `/api/workflow-runs/:runId/steps/:n/complete` | Step Stop-hook callback — advances |
| GET | `/api/workflow-runs/:runId?project=` | One run incl. recently finished (404 once forgotten) |
| POST | `/api/workflow-runs/:runId/cancel` | Cancel an active run (optional `?project=` pin) |
| GET | `/api/workflow-runs/active?project=` | Active workflow runs |
| GET | `/api/git-check?path=` | Repo probe: `hasGit` + walk-up `git` state (Git Setup chip) |
| POST | `/api/push-runs` | Start a one-off push session |
| GET | `/api/push-runs/:id` | Push-run status |
| POST | `/api/push-runs/:id/done` | Push-run Stop-hook callback |
| DELETE | `/api/push-runs/:id` | Forget a completed push run |
| POST | `/api/qa-runs` | Start a QA e2e Playwright session for a QA-lane task |
| GET | `/api/qa-runs/:id` | QA-run status/verdict |
| POST | `/api/qa-runs/:id/verdict` | Structured verdict; confident PASS may promote qa → done |
| POST | `/api/qa-runs/:id/done` | QA-run Stop-hook backstop |
| DELETE | `/api/qa-runs/:id` | Forget a completed QA run |
| GET | `/api/post-merge-hooks/active?project=` | Active or most-recent post-merge hook |
| POST | `/api/post-merge-hooks/:id/complete` | Post-merge hook completion callback |
| POST | `/api/post-merge-hooks/:id/abort` | Abort an active post-merge hook |
| GET | `/api/terminals` | Debug: active pty sessions |
| POST | `/api/terminals` | Pre-spawn a sidebar harness pty through the spawn chokepoint → `serverId` |
| DELETE | `/api/terminals/:id` | Kill a pty (ends its tab; aborts an owning post-merge hook) |
| GET | `/api/terminal-tabs?project=` | Durable terminal-tab records |
| POST | `/api/terminal-tabs/restore?project=` | Rebuild sidebar tabs (adopt live, relaunch dead into their conversation) |
| PATCH | `/api/terminal-tabs?project=` | Persist tab order `{order}` |
| PATCH | `/api/terminal-tabs/:id?project=` | Rename a tab `{label}` |
| DELETE | `/api/terminal-tabs/:id?project=` | Close a tab (never relaunched) and kill its pty (aborts an owning post-merge hook) |
| GET | `/api/spawn-queue` | Debug: spawn-queue snapshot |
| POST | `/api/internal/restart-drain/prepare` | Dev-runner restart drain (internal, token-guarded; see `backend/src/restartDrain/`) |
| POST | `/api/internal/restart-drain/cancel` | End a drain not followed by a restart (internal) |
| GET | `/api/internal/restart-drain/lock-holders` | Is each run.lock holder parked on a live agent? (internal) |
| GET | `/api/terminal-server/status` | Is the detached terminal-server current / stale / absent |
| GET | `/api/debug/memory` | Memory debug snapshot: this process's sample + gauges, trend, heap spaces, last browser samples (`memDiag/`) |
| POST | `/api/debug/heap-snapshot` | Write a V8 `.heapsnapshot` to `~/.lattice/logs/` (blocks the loop for seconds; explicit use only) |
| POST | `/api/debug/client-memory` | A browser tab's periodic memory sample → `[mem] browser#…` console line |
| WS | `/ws/terminal?id=&cwd=&cols=&rows=&initialCommand=` | xterm proxy via node-pty (with replay) |
| WS | `/ws/terminal-activity?project=` | Busy harness ptys `{busy: serverId[]}` (sidebar spinner; machine-wide) |
| WS | `/ws/terminal-tabs?project=` | Terminal-tab registry, live |
| WS | `/ws/tasks?project=` | Task updates + `task-spawned` / `task-spawn-failed` / `task-activity` / `agent-activity` |
| WS | `/ws/agent-sessions?project=` | Presence of non-worktree agent sessions (orange graph nodes) |
| WS | `/ws/merge-runs?project=` | Merge-run progress + resolver spawn events |
| WS | `/ws/post-merge-hooks?project=` | Post-merge hook state |
| WS | `/ws/workflows?project=` | Workflow definition updates |
| WS | `/ws/workflow-runs?project=` | Workflow run lifecycle + step terminal spawns |
| WS | `/ws/health?project=` | Incremental file-health updates |
| WS | `/ws/git-branch?project=` | Current branch, pushed on every `.git/HEAD` change |
| WS | `/ws/git-status?project=` | Git-status signature (HEAD + dirty set); timeline refetches on change |
| WS | `/ws/harnesses` | Harness availability snapshots |

Every project-scoped route refuses a relative or drive-relative `project` /
`path` / `cwd` with a **400** (shell-stripped backslashes: `C:developmentproj`
would otherwise resolve under the backend's cwd) — `routes/projectParam.ts`,
`routes/tasks/requestUtils.ts`. All WS endpoints share the HTTP server through
one `upgrade` dispatcher (`noServer: true`), routed by `pathname`
(`backend/src/ws/`).

## Security finding review and triage

Security findings review/triage (all project-scoped; source writes are proposed
through ordinary Open tasks):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/opengrep/triage?project=&findingId=` | Local disposition history (last 100) |
| POST | `/api/opengrep/triage` | `{project, scanId, findingId, status, reason, owner?, reviewAt?}` local ignore/defer/reopen |
| POST | `/api/opengrep/shared-ignore` | `{project, scanId, findingId, reason}` create a shared source/CI suppression review task |
| GET | `/api/opengrep/reviews?project=` | Review session metadata and current console identity; no recommendation reports |
| POST | `/api/opengrep/reviews` | `{project, scanId, findingIds, harness, piModel?}` start an interactive review of current open findings; harness waits for the user's choice |
| POST | `/api/opengrep/reviews/:id/done?project=` | Mark a review turn awaiting decision; durable callback keeps the conversation open |
| POST | `/api/opengrep/reviews/:id/cancel` | `{project}` end this conversation and reclaim guarded scratch; agreed tasks remain |
