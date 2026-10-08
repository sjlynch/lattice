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

Home-scoped state (`<hash>` = `projectHash(projectPath)` from
`backend/src/projectPath.ts`). Use the shared path/storage helpers: never
recompute hashes, rename stores, or derive a second lock/worktree dir from a new
path spelling ([PROJECT_IDENTITY.md](backend/src/PROJECT_IDENTITY.md)):

- `~/.lattice/projects.json` — global index of projects with Lattice tasks.
- `~/.lattice/per-project/<hash>/tasks.json` — task DB. Moved out of `<project>/.lattice/` after the 2026-05-09 catastrophic-deletion incident; legacy in-project files auto-migrate on first read. `run.lock` beside it is the cross-process per-project merge lock (`backend/src/projectRunLock/`).
- `~/.lattice/per-project/<hash>/push/<id>/` — push-run scratch; recursive cleanup is path-guarded to this home root and refused if it would land under the repo.
- `~/.lattice/per-project/<hash>/terminals.json` — durable terminal-tab registry (`backend/src/terminalRegistry/`).
- `~/.lattice/per-project/<hash>/{workflow-runs,push-runs,qa-runs,post-merge-hooks}.json` — mirrors of RUNNING one-off/workflow runs, re-adopted at boot (`recovery/workflowRunResume.ts`, `recovery/oneOffRunResume.ts`).
- `~/.lattice/per-project/<hash>/opengrep/` — stored Opengrep scans (last 10), complete result snapshots and content-hash cache sidecars.
- `~/.lattice/worktrees/<hash>/<slug>-<id>/` — per-task worktree checkout. **Outside the project tree on purpose** (2026-05-10): nesting them in `<repo>/.lattice/` caused three `.git`-deletion incidents. Only the `worktrees/<name>/gitdir` pointer lives in `<repo>/.git`.
- `~/.lattice/snapshots/<hash>/<ts>-<label>/` — copy-based working-tree snapshots (replace `git stash --include-untracked`, which silently lost data); orphans restored at boot. Also holds `*-discarded-worktree-*` **archives** of a force-removed worktree's uncommitted edits — keep-for-the-user, never auto-restored, newest 20 plus any under 7 days kept; if archiving fails the worktree is not removed. See `backend/src/worktree/snapshot/CLAUDE.md`.
- `~/.lattice/git-backups/<hash>/<ts>.bundle` — `git bundle --all` before a merge run (one under 10 min old is reused; skipped when disk is short; ≤5, ≤8 GB per project — `backend/src/worktree/CLAUDE.md`). Last-resort recovery: `git fetch <bundle>`.
- `~/.lattice/logs/` — crash forensics + memory time series (`mem-{backend,terminal-server,browser}.jsonl`, on-demand `heap-*.heapsnapshot`; the `[mem]` console line every 5 min — `backend/src/memDiag/CLAUDE.md`). **Check here first when something died** (the backend's console belongs to the user's terminal; the terminal-server runs `stdio: 'ignore'`): `crash-*.log`, `report.*.json` (JS-heap OOM / V8 fatal only — absence ≠ no crash), `live-*.log`, `crash-*-nojs.log` (the only record of a death that ran no JS: native fault, OS OOM-kill, `taskkill /F`), `dev-runner.log` (exit codes, Windows faults decoded). See `backend/src/CLAUDE.md`.
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

The full route map (every HTTP route + WS endpoint, drift-tested) is
[backend/src/routes/ROUTES.md](backend/src/routes/ROUTES.md); per-router
detail in `backend/src/routes/CLAUDE.md`. Two rules worth knowing up front:
every project-scoped route refuses a relative or drive-relative `project` /
`path` / `cwd` with a **400** (`routes/projectParam.ts`), and all WS endpoints
share the HTTP server through one `upgrade` dispatcher (`backend/src/ws/`).

## Conventions

Each bullet is an invariant plus the doc that owns the detail — read that doc
before changing the area.

- **UI:** no MUI; hand-written CSS (`frontend/src/index.css` → `frontend/src/styles/`)
  + `lucide-react`. Single sources of truth: `frontend/src/extensionStyles.ts`
  (sprite shape/color per extension — add a language there) and
  `frontend/src/taskColors.ts` (task/session colors; stable `Task.colorIndex` slots).
- **Graph** (`frontend/src/components/forceGraph/CLAUDE.md`): overlays `H`/`Z`/`D`/`W`/`Alt`;
  filter through `nodeVisibility`, never structural add/remove; render-on-demand
  idle reasons. The Security chip scans only on an explicit click — never on
  load, file change or project switch.
- **Agent presence:** every agent (Claude/Codex/Pi; task, workflow or
  user-started) is a graph node with focus beams; every hook shape decodes in
  `backend/src/activityHook.ts`; opening a project installs activity hooks
  (`backend/src/projectClaude/CLAUDE.md`). Codex ≥0.157 runs hooks through
  PowerShell 5.1: post with `cmd /c curl … -d@- <url>`, never `--data-binary @-`.
- **MCP** (`backend/src/mcp/CLAUDE.md`): resolved once at the spawn chokepoint
  (`resolveHarnessSpawnBody`); third-party servers off by default; secrets by
  env name only; **never set `defaultEnabled` on a third-party entry** (only
  Lattice's own `lattice` server has it).
- **Opengrep** (`backend/src/opengrep/CLAUDE.md`): downloaded on the user's click
  into `~/.lattice/opengrep/`; **nothing third-party is ever committed or
  bundled** (keeps Lattice MIT; guard test `opengrepNoVendoredAssets`). Agents
  see digests, never raw JSON.
- **Pi** (`backend/src/piModels/CLAUDE.md`, `backend/src/piSubagents/CLAUDE.md`):
  `piModel` (`provider/model`; the model half may contain `/`) is a separate
  field, never a composite with `harness`; a model the shared pattern
  (`backend/src/shared/harnesses.ts`) rejects has its `--model` silently
  dropped. The user's global Pi config is never touched.
- **Terminals** (`backend/src/terminal/CLAUDE.md`, `backend/src/terminalRegistry/CLAUDE.md`,
  `frontend/src/components/sidebar/CLAUDE.md`): tabs survive restarts (the
  conversation is pinned at spawn and relaunched into); spawns pre-create the
  pty and panes lazy-mount; Codex trust is a per-launch override, never
  `~/.codex/config.toml`; **never kill live ptys** to upgrade an indicator or default.
- **System prompts** (`backend/src/harnessSystemPrompts/CLAUDE.md`): per-harness
  Append/Replace plus the Lattice preamble naming `.lattice/LATTICE_API.md`
  (< 5 KB, generated from `backend/src/latticeApiDocs/`). Agent discovery goes
  through the system prompt only — **never reintroduce `LATTICE_*` pty env vars
  or rely on the terminal banner**; neither reaches the agent.
- **Task agents don't run tests, builds or type-checks** (brief + system prompt,
  `backend/src/taskVerification.ts`; per-project opt-in `taskAgentTypecheck`).
  A workflow's Run tests step verifies merged work once, commits fixes by
  explicit path only, and never stops the workflow
  (`backend/src/workflowRuns/testStep/CLAUDE.md`). A confident QA-run PASS
  auto-advances qa → done (`backend/src/qaRuns/`).
- **State:** tasks are an in-memory per-project cache with debounced JSON
  persistence (`backend/src/taskCache/`); per-project UI state is
  `localStorage` `lattice.<thing>.<projectPath>` plus
  `<project>/.lattice/userSettings.json` via `/api/settings`.
- **Memory:** register a gauge (`registerMemGauge`) beside every long-lived
  collection, listener set or GPU resource (`backend/src/memDiag/CLAUDE.md`).
- **Shared code:** logic or wire types both packages need live once in
  `backend/src/shared/` (relative imports only; the frontend imports it by
  path) — never a hand-mirrored copy (`backend/src/shared/CLAUDE.md`).
- Prefer editing existing files; no new abstractions for one-off tweaks.

## Ports

Frontend `:5183`, backend `:5184` — offset +10 from typical Vite (5173)
to avoid collisions with other local dev servers.

## Worktree paths

For a repo at `<repoRoot>` (with `<hash>` = `projectHash(repoRoot)`):

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

## Manual testing

Seeding tasks / high-conflict merge scenarios against a live instance:
[docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).
