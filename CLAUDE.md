# Lattice

Personal coding orchestrator. Manages parallel Claude Code / Codex / Pi agents
in git-worktree branches and visualizes a project's source tree as a 3D
force-directed DAG.

This file is the index. Subsystem detail lives in the `CLAUDE.md` beside the
code (`backend/src/CLAUDE.md` and `frontend/src/CLAUDE.md` map them) — open the
one that owns what you're touching before changing it.

## Layout

- `backend/` — TypeScript Node.js Express server (`:5184`)
- `frontend/` — Vite + React + TS + xterm + 3d-force-graph (`:5183`)
- `scripts/` — dev orchestration: root `npm run dev` runs `scripts/devLoop.mjs` (preflight → `scripts/orchestrate.mjs`, which supervises both; relaunched on a dev-console soft restart). See `scripts/CLAUDE.md`.
- `<project>/.lattice/` — per-project scratch (gitignored): `workflow-steps/`, `workflows.json`, `userSettings.json`, `health-cache.json`. **No longer holds worktrees, push-run scratch or tasks** — all moved to home-scoped paths below.

Home-scoped state (`<hash>` = `sha1(canonicalPath)[:12]`):

- `~/.lattice/projects.json` — global index of projects with Lattice tasks.
- `~/.lattice/per-project/<hash>/tasks.json` — task DB. Moved out of `<project>/.lattice/` after the 2026-05-09 catastrophic-deletion incident; legacy in-project files auto-migrate on first read. `run.lock` beside it is the cross-process per-project merge lock (`backend/src/projectRunLock/`).
- `~/.lattice/per-project/<hash>/push/<id>/` — push-run scratch; recursive cleanup is path-guarded to this home root and refused if it would land under the repo.
- `~/.lattice/per-project/<hash>/terminals.json` — durable terminal-tab registry (`backend/src/terminalRegistry/`).
- `~/.lattice/per-project/<hash>/{workflow-runs,push-runs,qa-runs,post-merge-hooks}.json` — mirrors of RUNNING one-off/workflow runs, re-adopted at boot (`recovery/workflowRunResume.ts`, `recovery/oneOffRunResume.ts`).
- `~/.lattice/per-project/<hash>/opengrep/` — stored Opengrep scans (last 10).
- `~/.lattice/worktrees/<hash>/<slug>-<id>/` — per-task worktree checkout. **Outside the project tree on purpose** (2026-05-10): nesting them in `<repo>/.lattice/` caused three `.git`-deletion incidents. Only the `worktrees/<name>/gitdir` pointer lives in `<repo>/.git`.
- `~/.lattice/snapshots/<hash>/<ts>-<label>/` — copy-based working-tree snapshots (replace `git stash --include-untracked`, which silently lost data); orphans restored at boot. Also holds `*-discarded-worktree-*` **archives** of a force-removed worktree's uncommitted edits — keep-for-the-user, never auto-restored, newest 20 kept; if archiving fails the worktree is not removed. See `backend/src/worktree/snapshot/CLAUDE.md`.
- `~/.lattice/git-backups/<hash>/<ts>.bundle` — `git bundle --all` before each merge run (≤5, ≤8 GB per project). Last-resort recovery: `git fetch <bundle>`.
- `~/.lattice/logs/` — crash forensics. **Check here first when something died** (the backend's console belongs to the user's terminal; the terminal-server runs `stdio: 'ignore'`): `crash-*.log`, `report.*.json` (JS-heap OOM / V8 fatal only — absence ≠ no crash), `live-*.log`, `crash-*-nojs.log` (the only record of a death that ran no JS: native fault, OS OOM-kill, `taskkill /F`), `dev-runner.log` (exit codes, Windows faults decoded). See `backend/src/CLAUDE.md`.
- `~/.lattice/globalSettings.json` — machine-global settings (`backend/src/globalSettings/`); `~/.lattice/mcpSecrets.json` (`0600`) — MCP secrets; `~/.lattice/piManagedProviders.json` — Pi providers Lattice owns in `~/.pi/agent/models.json`.
- `~/.lattice/bin/lattice-callback.cjs` + `~/.lattice/callback-outbox/` — durable completion callbacks: every Stop hook records, POSTs with retries, and the backend replays whatever was undelivered while it restarted (`backend/src/callbackOutbox/`).
- `~/.lattice/opengrep/` — the Lattice-managed Opengrep engine + rule packs (`backend/src/opengrep/`).

**Disk space** (`backend/src/worktree/CLAUDE.md` → "Disk"): a run whose checkout doesn't fit above `minFreeDiskGb` **waits in the spawn queue** (never fails) and may trigger a merge of Ready-to-Merge tasks (`diskPressureMerge.ts`). LFS files are pointer stubs in worktrees by default (agents `git lfs pull --include=<path>`). A merge refuses under 1 GB free. **Git auto-gc is off** for all git Lattice runs and every agent it spawns (it once made 80 GB of pack copies in minutes). Checkouts run two at a time and a resource governor (`spawnQueue/`) holds spawns under CPU/RAM pressure.

### `.git`-deletion defences (read before touching the merge pipeline)

Every prior incident traced to a recursive filesystem delete reaching `.git` (directly via `fs.rm`, or via a lost `git stash --include-untracked`). Layered defences, outermost first: (1) worktrees and push-run scratch live outside the project tree; (2) `projectGit()` — all git against the project repo goes through a wrapper that whitelists subcommands (no `clean`/`stash`/`reset --hard`/`update-ref -d`/non-ff `merge`/`branch -D <non-lattice>`/`checkout <branch>`/…); (3) no raw `fs.rm` fallback in worktree cleanup — recursive removal is delegated to `git worktree remove`; (4) `pruneReparsePointsUnder` strips any junction/symlink before recursive scratch removal so neither git's recursion nor Lattice's `fs.rm` can walk a reparse-point loop (an in-worktree `npm install` of a `file:..` self-dep was the realistic source — and `backend`/`frontend` no longer carry that self-dep); (5) copy-based snapshots, never `git stash`; (6) a run circuit breaker that halts the whole merge run if `.git` vanishes or HEAD moves non-forward between tasks; (7) the `git bundle` backup above; (8) `assertNotReparsePoint` on the remaining `fs.rm` sites, snapshot-manifest path validation, guarded push-run cleanup, and a cross-process project run lock. See `backend/src/worktree/CLAUDE.md`.

## Run

```
npm run dev
```

**Do not start, stop, or restart the dev server yourself.** The user runs it
in their own terminal and watches the output for errors. Restarting it from
inside Claude steals their console, drops their HMR/WS connections, and
hides errors they were already debugging. Type-check via `tsc` to validate
your changes — the user will reload the running server when they're ready.

Dev-console line commands (hint printed at boot): `r` = soft restart (the
detached terminal-server is kept, so running agents are re-adopted), `d` = exit
keeping agents running, `i` = re-check/install deps. Ctrl+C is the full stop
that ends every agent. A `package.json` / lockfile change after boot (e.g. a
merge) is `npm install`ed automatically (`scripts/depsWatch.mjs`). See
`scripts/CLAUDE.md`.

Type-check:
- backend: `cd backend && npx tsc --noEmit`
- frontend: `cd frontend && npx tsc -b`

The backend refuses to boot (before touching `~/.lattice`) when its code or cwd
is inside a task worktree, or when another backend holds its port
(`backend/src/server/bootGuards.ts`; `LATTICE_ALLOW_WORKTREE_BACKEND=1` only for
an instance with its own HOME and ports).

E2E (Playwright): `npm run test:e2e` from the repo root. It never touches the
live instance: `playwright.config.ts` boots an **isolated** backend + vite +
terminal-server on `:5384`/`:5383`/`:5385` with HOME at `<tmp>/lattice-e2e-home`
(overrides: `LATTICE_E2E_{BACKEND,FRONTEND,TERMINAL}_PORT`, `LATTICE_E2E_HOME`),
from the already-built `backend/dist` (kept current by `npm run dev`, or
`npm --prefix backend run build`). `LATTICE_E2E_BASE_URL` targets an existing
server; pointing it at the live `:5183`/`:5184` also needs
`LATTICE_E2E_ALLOW_LIVE=1`. Underlying overrides: backend `PORT`,
`TERMINAL_PORT`, `LATTICE_FRONTEND_PORT`, `LATTICE_DEFAULT_ROOT`; vite
`LATTICE_FRONTEND_PORT`, `LATTICE_BACKEND_PORT`, `LATTICE_VITE_CACHE_DIR`.

## Git discipline

**Stay on the `main` branch unless otherwise specified.** Do work, commit,
and push on `main` by default; only switch to (or create) another branch when
the user explicitly asks for it, and switch back to `main` when that work is
done.

**Exception — Lattice-spawned agents.** A task agent working in a
`~/.lattice/worktrees/…` checkout commits on its own `lattice/<slug>-<id>`
branch and never checks out, merges into, or pushes `main` — Lattice merges it.
Nor does it start the backend / `npm run dev` there. A merge-resolver or
workflow-step agent follows its brief (`MERGE_INSTRUCTIONS.md`,
`WORKFLOW_STEP.md`, …) over this section.

## Task pipeline

```
Backlog ──▶── Open ──▶── In Progress ──▶── Ready to Merge ──▶── QA ──▶── Done
                                                                       (Deleted bin)
```

- `Backlog → Open`: Backlog holds not-yet-actionable tasks (no ▶ button); Open
  is the ready-to-run lane. Lanes/transitions:
  `frontend/src/components/taskboard/lanes.ts` + `moveTargets.ts`.
- `Open → In Progress`: ▶ calls `POST /api/tasks/:id/run`, which **enqueues**
  the run and returns `{accepted, queued}` — `accepted` means *admitted*, not
  *started*. The pty arrives later via the `task-spawned` WS event, so don't read
  the response as "the worktree exists now", and don't re-POST (`/resume`
  behaves identically). Once admitted, the backend creates the worktree + branch,
  writes `LATTICE_TASK.md`, and installs completion hooks: a Claude Stop hook
  (always — a conflicted Pi/Codex task is resolved by a *Claude* resolver), a Pi
  `.pi/extensions/lattice-complete.ts` (Pi also curls `/complete` itself), and a
  Codex `.codex/hooks.json` `Stop` hook (`backend/src/codexStopHook.ts`, written
  `if-absent` so a repo's own file is never clobbered).
- `In Progress → Ready to Merge`: the hook hits `POST /api/tasks/:id/complete`
  (idempotent; flips only when the branch has a commit), delivered through the
  callback outbox so a Stop during a backend restart is replayed, not lost.
- `Ready to Merge → QA`: `POST /api/tasks/:id/merge` merges main INTO the branch
  *inside the worktree* (main's working tree never gets conflict markers; vite
  stays alive), then fast-forwards main. Clean → `qa`, worktree + branch
  removed. Conflict → `MERGE_INSTRUCTIONS.md` + a resolver Claude in the
  worktree, whose Stop → `/complete` detects the resolved merge and finalizes.
  `/merged` / `/merge-aborted` are explicit fallbacks. See
  `backend/src/worktree/merge/CLAUDE.md`.
- `QA → Done`: manual (drag, or "mark all QA → Done"), or automatic when a QA
  e2e run reports a *confident PASS* (`backend/src/qaRuns/`).

### Merge runs (backend-driven "merge all")

`POST /api/merge-runs {project}` runs every `ready_to_merge` task in
`createdAt` order, continuing past conflicts (resolvers spawned via WS). It
lives in the backend — closing the tab doesn't cancel it; the UI re-syncs via
`GET /api/merge-runs/active`. One run per project (second start → 409).
Per-task locks (`backend/src/mergeLocks.ts`) keep a manual `/merge` off a task
the run is processing. See `backend/src/mergeRuns/CLAUDE.md`.

The run executes *inside the backend process*, which the dev runner restarts
when a merged task fast-forwards `main` with a `backend/src` change. Two layers
keep "merge all" one-click: (1) the backend dev runner (`backend/scripts/dev.mjs`,
a thin entry over `backend/scripts/dev/` — deferral in `dev/restartPolicy.mjs`,
drain handshake in `dev/restartHandshake.mjs`) doesn't restart while a
per-project `run.lock` is held, with a 15-minute force backstop for a wedged
holder that is skipped while the run is parked on a live conflict resolver /
post-merge hook, and drains the backend before every restart (see
`backend/scripts/CLAUDE.md`, `backend/src/restartDrain/CLAUDE.md`); (2) if a
restart happens anyway, boot's `resumeInterruptedMergeRuns` sees the stale
`merge-run` lock and restarts a run for what's still `ready_to_merge`. **The
merge-run logic must therefore stay safely re-runnable** (re-attempts are
idempotent on half-done tasks).

## HTTP / WS surface

Full per-route detail: the route modules (`backend/src/routes/CLAUDE.md`) and
the agent-facing `backend/src/latticeApiDocs/*.template.md`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness probe |
| GET | `/api/harnesses?refresh=1` | Detected agent CLIs (`claude` / `pi` / `codex`) |
| GET | `/api/default-root` | Default project for the UI |
| GET | `/api/scan?path=` | Recursive source-file scan, gitignore-aware |
| GET | `/api/search?project=&q=&regex=` | File-contents search → `{matches, scanned, truncated}` (abs paths == graph node ids); `*`/`?` wildcards unless `regex=1` |
| GET | `/api/health/dead-code?project=` | Files confidently flagged unreachable (60s-memoized) |
| GET | `/api/git-history?path=&limit=` | Timeline history (`git log --name-status -M`) + `deletedPaths` for ghost nodes |
| GET | `/api/git-branch?path=` | Current branch (one-shot; navbar uses `/ws/git-branch`) |
| GET | `/api/list-dir?path=` | Folder browser |
| POST | `/api/create-dir` | Folder-picker create-directory `{parent, name}` |
| GET | `/api/settings?project=` | Read per-project user settings |
| PATCH | `/api/settings?project=` | Merge-update per-project user settings |
| GET | `/api/instruction-templates?project=` | Editable agent brief templates (default, current, `{{token}}` docs); saved via PATCH `/api/settings` |
| GET | `/api/harness-system-prompts?project=` | Per-harness system-prompt editor data (default overview + Append/Replace override) |
| GET | `/api/global-settings` | Read machine-global settings |
| PATCH | `/api/global-settings` | Update machine-global settings (softCap applied live; `piProviders` reconciled into models.json) |
| GET | `/api/pi-models` | Pi models + curated "Pi — X" `menu` + Pi's `defaultPattern` |
| POST | `/api/pi-endpoints/probe` | `{baseUrl, apiKey?}` → models an OpenAI-compatible server serves (+ context window) |
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
| POST | `/api/opengrep/scan` | `{project, targets?, includeMarkdown?}` run a scan (**409** `busy`/`not-installed`/`no-rules`, **400** `bad-target`) |
| GET | `/api/opengrep/scans?project=` | Recent scan records |
| GET | `/api/opengrep/scans/:id?project=&format=md&…` | One scan (`latest` ok) as the filtered agent digest |
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
| POST | `/api/tasks/:id/complete` | Stop-hook callback (in_progress → ready_to_merge) |
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
| POST | `/api/workflows/:id/run` | Start a run; one per project (**409** `active-run-exists`) |
| POST | `/api/workflow-prompt-customizations` | Spawn a harness to tailor a step prompt |
| GET | `/api/workflow-prompt-customizations/:id` | Poll customization status/result |
| POST | `/api/workflow-prompt-customizations/:id/complete` | Harness callback with the customized prompt |
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

## Conventions

Each bullet names the invariant; the linked `CLAUDE.md` owns the detail.

- **No MUI.** UI is hand-written CSS — `frontend/src/index.css` is an ordered
  `@import` list over feature files in `frontend/src/styles/` (see
  `frontend/src/styles/CLAUDE.md`) — plus `lucide-react` icons.
- **`frontend/src/extensionStyles.ts`** is the single source of truth for
  sprite shapes/colors per file extension (3D graph + Legend). To add a
  language, add an entry there.
- **`frontend/src/taskColors.ts`** is the single source of truth for per-task
  accent colors (card edge, graph agent node, `W` rings) and session colors
  (Claude orange, Codex white, Pi blue). Each running task gets a stable palette
  slot (`Task.colorIndex`, `backend/src/routes/tasks/colorSlot.ts`, with an
  in-memory reservation so concurrent starts don't pick the same slot) through a
  golden-angle palette, so colors never reshuffle when a sibling finishes.
- **Graph overlays** — hold-key or click-to-pin chips in the overlay key:
  `H` health, `Z` lines of code, `D` dead code, `W` worktree-modified files,
  `Alt` labels. Metric views (`H`/`Z`/`D`) hide ghost nodes and
  metrics-ignored extensions (`DEFAULT_METRICS_IGNORED_EXTS`) and suppress
  change-rings. Dead code = reachability from detected entry points
  (`backend/src/health/crossFile/`, extra roots in
  `userSettings.deadCodeEntryGlobs`), also served to agents at
  `/api/health/dead-code`. Camera/sprite/filtering rules (OrbitControls, +Y
  up, `nodeVisibility` filtering): `frontend/src/components/forceGraph/CLAUDE.md`.
- **Agent overlay (graph).** Every in-progress agent (Claude, Codex, Pi) is a
  node with TTL-fading focus beams to the files it touches and a current-file
  label; subagents are satellites with their own labels (`showSubagentLabels`
  graph setting, off by default, prefixes the `agent_type`). Claude hooks, Codex
  `.codex/hooks.json` and the Pi `lattice-activity.ts` extension all decode in
  `backend/src/activityHook.ts`. Non-worktree sessions (push / workflow step /
  post-merge) are fixed orange (`backend/src/agentSessions.ts`).
- **Any agent session in an opened project** (even one the user started) gets a
  node: project open merges activity hooks into the project's
  `.claude/settings.local.json` (`projectClaudeHooks.ts`, opt-out
  `instrumentProjectClaudeSessions`); user-opened Codex tabs get per-launch
  `--config hooks.*` overrides plus `--dangerously-bypass-hook-trust`
  (`projectCodexHooks.ts`, nothing written to the repo or `~/.codex`); Pi gets a
  project-root activity extension. Presence follows turns — up on prompt/tool
  use, down 15 s after `Stop`, gone on SessionEnd or the tab's pty ending. A
  session must be (re)started to pick up new hooks. See
  `backend/src/projectClaude/CLAUDE.md`.
- **Codex ≥0.157 runs hook commands through PowerShell 5.1 on Windows**: a bare
  `@-` is a parse error there (and bare `curl` is `Invoke-WebRequest`), so Codex
  hooks post with `cmd /c curl … -d@- <url>`, never `--data-binary @-`.
- **MCP servers** are curated once in Lattice and injected into every Claude /
  Codex / Pi session it spawns, resolved at the one spawn chokepoint
  (`resolveHarnessSpawnBody`). Third-party servers are off by default, one
  switch per harness; secrets reach servers by env name only. The one
  `defaultEnabled` server is Lattice's own `lattice` board server
  (`backend/src/latticeMcp/`) — **never set `defaultEnabled` on a third-party
  entry**. Task-worktree sessions get a reduced tool set and, by default, ONLY
  `lattice`. Playwright has two independent toggles (global vs. QA-runs-only).
  See `backend/src/mcp/CLAUDE.md`.
- **QA e2e runs** (`backend/src/qaRuns/`) — when the QA-lane Globe is on, ▶
  spawns a Playwright-scoped Claude that tests the merged task, appends a
  verdict, and posts a structured one; a confident PASS auto-advances qa → done.
- **Opengrep (SAST) is a pre-run tool, not a dependency.** Engine and rule
  packs are downloaded at the user's click (pinned SHA-256 / pinned commits) into
  `~/.lattice/opengrep/`; **Lattice stays MIT because nothing third-party is
  ever committed or bundled** (guard test `opengrepNoVendoredAssets`). Agents
  see a filtered, fingerprint-deduped digest, never raw JSON — via the Opengrep
  workflow step (`OPENGREP_FINDINGS.md`), the `opengrep_*` MCP tools, or
  `/api/opengrep/*`. Task marker `opengrep:<fp>` on its own line. See
  `backend/src/opengrep/CLAUDE.md`.
- **Pi sub-agents** (`@tintinweb/pi-subagents`) auto-install into
  `~/.lattice/pi-extensions/` when `pi` is detected and load via a cwd-exact shim
  (`.pi/extensions/lattice-subagents.ts`) in every Pi cwd Lattice creates and at
  the project root — the user's global Pi config is never touched. See
  `backend/src/piSubagents/CLAUDE.md`.
- **Pi model selection** is a second field `piModel` (`provider/model`) beside
  the `harness` enum — never a composite — detected from `pi --list-models`
  (stderr) + `~/.pi/agent/models.json`, applied per spawn as `--model` by
  `buildPiModelFlag` (`backend/src/agentCommandBuilder.ts`); Lattice never
  writes Pi's `settings.json`. **The model half may contain further slashes**
  (an OpenAI-compatible server reports e.g.
  `my-vllm/meta-llama/Llama-3.1-8B-Instruct`), **and the frontend mirror
  `PI_MODEL_RE` (`frontend/src/harnesses.ts`) must stay in lockstep with the
  backend pattern: a pattern either side rejects has its `--model` flag
  *silently dropped*, so the session runs Pi's default model instead of the
  chosen one.** Endpoints (`globalSettings.piProviders`) are reconciled into
  models.json and auto-discovered — `backend/src/piModels/CLAUDE.md`. Gotchas
  not yet there: only currently-served models are discoverable; thinking-level
  probing caps at `thinkingProbeModelLimit` (25), looser than the aggregator
  cutoff (5); a `$VAR` / `!command` `apiKey` always fails its probe (keeps its
  last models — configure by hand); duplicate model ids across endpoints get a
  `(provider)` label suffix on the colliding rows only.
- **Tasks store** is in-memory keyed by project with debounced JSON persistence;
  `~/.lattice/projects.json` is consulted lazily so Stop-hook callbacks resolve
  task ids across sessions (`backend/src/taskCache/`).
- **Per-project UI state** — filter/panel state in `localStorage` under
  `lattice.<thing>.<projectPath>`; user settings in
  `<project>/.lattice/userSettings.json` via `/api/settings` (type in
  `backend/src/userSettings.ts`, frontend helpers in
  `frontend/src/api/settings.ts`).
- Prefer editing existing files; don't introduce new abstractions for one-off
  tweaks.
- **Per-tab agent spinner** (`backend/src/terminalActivity.ts` →
  `/ws/terminal-activity`): Codex is classified by its explicit status terminal
  title (injected per launch, never global config), never by printable output;
  Claude/Pi by sustained printable output the user isn't driving; harness
  sessions only. Backend-derived because unopened tabs have no WS. The same Codex
  injection caps `tui.terminal_resize_reflow_max_rows` at 500 (9001 under
  `WT_SESSION` made a resize take minutes). **Never kill live ptys to upgrade
  this indicator.** See `frontend/src/components/sidebar/CLAUDE.md`,
  `backend/src/terminal/CLAUDE.md`.
- **Terminal tabs survive restarts and reboots**: every pty is recorded in the
  per-project registry; the harness conversation is pinned at spawn (Claude
  `--session-id`, Pi `--session-id lattice-<uuid>`, Codex thread id learned
  afterwards), and on project open dead tabs are relaunched *into their previous
  conversation*. One-shot runs (push / QA / post-merge / workflow steps) are
  owned by their own recovery and never resurrected here. See
  `backend/src/terminalRegistry/CLAUDE.md`.
- **Terminal pty pre-spawn**: task/workflow/conflict spawns pre-create the pty
  and return a `serverId`; the frontend lazy-mounts `<TerminalPane>` on first
  activation so "Run All" can't blow past Chrome's per-page WebGL context cap.
- **Codex trust is per terminal, not global** — a one-shot
  `projects.<cwd>.trust_level='trusted'` override via child-only env; never
  writes `~/.codex/config.toml` (`backend/src/terminal/`).
- **Per-harness system-prompt overrides** (Append / Replace per harness,
  `UserSettings.harnessSystemPrompts`) are injected at the spawn chokepoint.
  Claude's built-in prompt is proprietary (the editor says so; the override
  still works); replacing is discouraged. See
  `backend/src/harnessSystemPrompts/CLAUDE.md`.
- **Lattice self-discovery is a system-prompt preamble** on that same append
  channel (`harnessSystemPrompts/latticePreamble.ts`), pointing at the project's
  auto-generated `.lattice/LATTICE_API.md` — a short index (≤ ~3.5 KB) that
  points at `.lattice/LATTICE_API_RECIPES.md`; both regenerate from
  `backend/src/latticeApiDocs/*.template.md` and are drift-tested against the
  live route table. It is a system prompt (not a typed first turn) so it stays
  invisible and out of Claude Code's session naming. **Two earlier channels
  could never work and must not be reintroduced**: `LATTICE_*` pty env vars
  (removed — no harness reads the environment into its context) and the dim
  terminal banner (kept, but it lands in the scrollback the browser replays, so
  the pty child never receives it — it informs the *user*, not the agent).
- **Task agents don't run tests.** Task run/resume sessions and their worktree
  merge resolvers are told — in the brief's `{{verification}}` block AND their
  system prompt — to run no test suite, build or type-check, overriding repo
  CLAUDE.md/AGENTS.md and the task description (`backend/src/taskVerification.ts`).
  A workflow's Run tests step verifies merged work once instead. Per-project
  opt-in `taskAgentTypecheck` allows a type-check of the edited package(s).
- **Workflow "Run tests" step** (kind `test`, usually `… → Merge → Run tests →
  Push`) runs the project's tests on the main checkout, commits fixes with
  `git commit -- <paths>` only, leaves the user's WIP alone, and **never stops
  the workflow** (skip / failure / timeout = note + advance). It holds the
  project `run.lock` non-lendably, so manual Merge gets a 409 meanwhile. See
  `backend/src/workflowRuns/testStep/CLAUDE.md`.

## Ports

Frontend `:5183`, backend `:5184` — offset +10 from typical Vite (5173)
to avoid collisions with other local dev servers.

## Worktree paths

For a repo at `<repoRoot>` (with `<hash>` = `sha1(canonicalPath)[:12]`):

- worktree dir: `~/.lattice/worktrees/<hash>/<slug>-<shortid>` — **outside**
  the project tree (see the `.git`-deletion defences above). `git worktree
  add` records the worktree at `<repoRoot>/.git/worktrees/<name>/` regardless
  of where the checkout lives.
  - legacy: worktrees created before 2026-05-10 are at
    `<repoRoot>/.lattice/worktrees/<slug>-<shortid>`. Those keep working
    (the task record stores `worktreePath` explicitly); the boot-time
    `sweepOrphanedWorktrees` reclaims any that outlive their task.
- branch: `lattice/<slug>-<shortid>`
- task instructions inside the worktree: `LATTICE_TASK.md`
- conflict-resolver instructions inside the worktree:
  `<worktree>/MERGE_INSTRUCTIONS.md`

## Creating tasks via the API (e.g. for testing)

To seed tasks programmatically, POST to `/api/tasks`:

```bash
curl -s -X POST http://127.0.0.1:5184/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "project": "C:\\development\\lattice",
    "title": "Bump version comment to 1.0.1",
    "description": "in frontend/src/api/index.ts at the top of the file, add a comment `// version 1.0.1` (replacing any existing version comment)."
  }'
```

The response is the new task with its `id`. Run a task with
`POST /api/tasks/:id/run`.

### Seeding low-change / high-conflict tasks for end-to-end testing

To stress the merge pipeline, create N tasks that all touch the same one
or two lines in the same file. Each task in isolation makes a tiny edit;
when several land at the same time, every merge after the first one
conflicts on the same hunk — exercising the resolver flow at scale.

Pattern: ask each task to set the same constant to a different value at
the top of one file. Example for Lattice's own repo, all 5 modifying
`frontend/src/api/index.ts`:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST http://127.0.0.1:5184/api/tasks \
    -H "Content-Type: application/json" \
    -d "{
      \"project\": \"C:\\\\development\\\\lattice\",
      \"title\": \"version stamp ${i}\",
      \"description\": \"At the very top of frontend/src/api/index.ts, add or replace a single line that reads exactly: // lattice-test-stamp: ${i}. Do not edit anything else in the file.\"
    }"
done
```

After seeding, click "Run All" on the Open lane to spawn worktree
Claudes, then "Merge All" on Ready-to-Merge. The first merge will land
clean; subsequent ones should hit a one-line conflict on the stamp,
trigger a resolver Claude in each worktree, and (assuming the resolver
just keeps the incoming side) finalize automatically.
