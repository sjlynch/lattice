# Lattice architecture

On-demand reference, not auto-loaded: the cross-cutting picture that only
matters when you touch that area. Rules for code live in the `CLAUDE.md`
beside it; each section names its owner doc, and the owner wins where the two
disagree (fix this file). Module maps: the `MAP.md` beside a package's
`CLAUDE.md`.

## State on disk

### Home-scoped: `~/.lattice/`

`<hash>` = `projectHash(projectPath)` from `backend/src/projectPath.ts`. Use the
shared path/storage helpers: never recompute hashes, rename stores, or derive a
second lock/worktree dir from a new path spelling
(`backend/src/PROJECT_IDENTITY.md`).

`LATTICE_HOME` relocates this whole root (`backend/src/latticeHome.ts`;
`scripts/latticeHome.mjs` for the dev runner). A second instance on its own
ports (`PORT`, `TERMINAL_PORT`) sets it instead of `HOME`, so its agents keep
the user's real `~/.claude` / `~/.codex` / `~/.pi` auth.

- `~/.lattice/projects.json` — global index of projects with Lattice tasks
  (`backend/src/taskCache/CLAUDE.md`).
- `~/.lattice/per-project/<hash>/tasks.json` — the task DB. Moved out of
  `<project>/.lattice/` after the 2026-05-09 catastrophic-deletion incident;
  legacy in-project files auto-migrate on first read. `run.lock` beside it is
  the cross-process per-project merge lock (`backend/src/projectRunLock/CLAUDE.md`).
- `~/.lattice/per-project/<hash>/push/<id>/` — push-run scratch (QA and
  post-merge-hook scratch sit beside it); recursive cleanup is path-guarded to
  this home root and refused if it would land under the repo
  (`backend/src/homeScratch/CLAUDE.md`).
- `~/.lattice/per-project/<hash>/terminals.json` — durable terminal-tab
  registry (`backend/src/terminalRegistry/CLAUDE.md`).
- `~/.lattice/per-project/<hash>/{workflow-runs,push-runs,qa-runs,post-merge-hooks}.json`
  — mirrors of RUNNING one-off/workflow runs, re-adopted at boot
  (`backend/src/recovery/workflowRunResume.ts`,
  `backend/src/recovery/oneOffRunResume.ts`).
- `~/.lattice/per-project/<hash>/opengrep/` — stored Opengrep scans (last 10),
  complete result snapshots and content-hash cache sidecars.
- `~/.lattice/worktrees/<hash>/<slug>-<id>/` — per-task worktree checkout,
  outside the project tree on purpose ("Worktree paths").
- `~/.lattice/snapshots/<hash>/<ts>-<label>/` — copy-based working-tree
  snapshots (they replace `git stash --include-untracked`, which silently lost
  data); orphans are restored at boot. Also holds `*-discarded-worktree-*`
  **archives** of a force-removed worktree's uncommitted edits — kept for the
  user, never auto-restored, newest 20 plus any under 7 days kept; if archiving
  fails the worktree is not removed (`backend/src/worktree/snapshot/CLAUDE.md`).
- `~/.lattice/git-backups/<hash>/<ts>.bundle` — `git bundle --all` before a
  merge run (`backend/src/worktree/gitBackup.ts`): one under 10 min old is
  reused; skipped when disk is short; ≤ 5 and ≤ 8 GB per project
  (`backend/src/worktree/CLAUDE.md`). Last-resort recovery: `git fetch <bundle>`.
- `~/.lattice/logs/` — crash forensics + memory time series ("Crash forensics").
- `~/.lattice/globalSettings.json` — machine-global settings
  (`backend/src/globalSettings/CLAUDE.md`); `~/.lattice/mcpSecrets.json`
  (`0600`) — MCP secrets (`backend/src/mcp/CLAUDE.md`);
  `~/.lattice/piManagedProviders.json` — Pi providers Lattice owns in
  `~/.pi/agent/models.json` (`backend/src/piModels/CLAUDE.md`).
- `~/.lattice/bin/lattice-callback.cjs` + `~/.lattice/callback-outbox/` —
  durable completion callbacks: every Stop hook records, POSTs with retries,
  and the backend replays whatever was undelivered while it restarted
  (`backend/src/callbackOutbox/CLAUDE.md`).
- `~/.lattice/opengrep/` — the Lattice-managed Opengrep engine + rule packs
  (`backend/src/opengrep/CLAUDE.md`).

### Per-project: `<project>/.lattice/` (gitignored)

Scratch only: `workflow-steps/`, `workflows.json`, `userSettings.json`,
`health-cache.json`, and the generated agent API docs (`LATTICE_API.md`,
`LATTICE_API_RECIPES.md`). It **no longer holds worktrees, push-run scratch or
tasks** — all moved to the home-scoped paths above.

### Crash forensics: `~/.lattice/logs/`

**Check here first when something died**: the backend's console belongs to the
user's terminal, and the terminal-server runs `stdio: 'ignore'`.

- `crash-*.log` — written by the crash handler (`backend/src/crashLog/CLAUDE.md`).
- `report.*.json` — Node diagnostic report, JS-heap OOM / V8 fatal only;
  absence ≠ no crash.
- `live-*.log` — the running process's mirror; promoted next boot to
  `crash-*-nojs.log`, the only record of a death that ran no JS (native fault,
  OS OOM-kill, `taskkill /F`).
- `dev-runner.log` — dev-runner exit codes, Windows faults decoded
  (`backend/scripts/dev/CLAUDE.md`).
- `mem-{backend,terminal-server,browser}.jsonl` + on-demand
  `heap-*.heapsnapshot`; the `[mem]` console line every 5 min
  (`backend/src/memDiag/CLAUDE.md`).

## Disk space

Owner: `backend/src/worktree/CLAUDE.md` → "Disk space, LFS, gc".

- A run whose checkout doesn't fit above `minFreeDiskGb` **waits in the spawn
  queue** (never fails) and may trigger a merge of Ready-to-Merge tasks
  (`backend/src/diskPressureMerge.ts`).
- LFS files are pointer stubs in worktrees by default (agents
  `git lfs pull --include=<path>`).
- A merge refuses under 1 GB free.
- **Git auto-gc is off** for all git Lattice runs and every agent it spawns (it
  once made 80 GB of pack copies in minutes).
- Checkouts run two at a time, and a resource governor
  (`backend/src/spawnQueue/CLAUDE.md`) holds spawns under CPU/RAM pressure.

## `.git`-deletion defences

Read before touching the merge pipeline, worktree teardown or any scratch
cleanup. Maintained list: `backend/src/worktree/CLAUDE.md`. Every prior incident
traced to a recursive filesystem delete reaching `.git` (directly via `fs.rm`,
or via a lost `git stash --include-untracked`). Layers, outermost first:

1. Worktrees and push-run scratch live outside the project tree (nesting
   worktrees in `<repo>/.lattice/` caused three `.git`-deletion incidents).
2. `projectGit()` — all git against the project repo goes through a wrapper
   that whitelists subcommands (no `clean` / `stash` / `reset --hard` /
   `update-ref -d` / non-ff `merge` / `branch -D <non-lattice>` /
   `checkout <branch>` / …).
3. No raw `fs.rm` fallback in worktree cleanup — recursive removal is delegated
   to `git worktree remove`.
4. `pruneReparsePointsUnder` strips any junction/symlink before recursive
   scratch removal, so neither git's recursion nor Lattice's `fs.rm` can walk a
   reparse-point loop (an in-worktree `npm install` of a `file:..` self-dep was
   the realistic source — `backend`/`frontend` no longer carry that self-dep).
5. Copy-based snapshots, never `git stash`.
6. A run circuit breaker (`backend/src/mergeRuns/repoIntegrity.ts`) halts the
   whole merge run if `.git` vanishes or HEAD moves non-forward between tasks.
7. The `git bundle` backup above.
8. `assertNotReparsePoint` on the remaining `fs.rm` sites, snapshot-manifest
   path validation, guarded push-run cleanup, and a cross-process project run
   lock.

## Task pipeline

```
Backlog ──▶── Open ──▶── In Progress ──▶── Ready to Merge ──▶── QA ──▶── Done
                                                                       (Deleted bin)
```

- **Backlog → Open**: Backlog holds not-yet-actionable tasks (no ▶ button);
  Open is the ready-to-run lane. Lanes/transitions:
  `frontend/src/components/taskboard/lanes.ts` + `moveTargets.ts`.
- **Open → In Progress**: ▶ calls `POST /api/tasks/:id/run`, which **enqueues**
  the run and returns `{accepted, queued}` — `accepted` means *admitted*, not
  *started*. The pty arrives later via the `task-spawned` WS event, so don't
  read the response as "the worktree exists now", and don't re-POST (`/resume`
  behaves identically). Once admitted, the backend creates the worktree +
  branch, writes `LATTICE_TASK.md`, and installs completion hooks: a Claude
  Stop hook (always — a conflicted Pi/Codex task is resolved by a *Claude*
  resolver), a Pi `.pi/extensions/lattice-complete.ts` (Pi also curls
  `/complete` itself), and a Codex `.codex/hooks.json` `Stop` hook
  (`backend/src/codexStopHook.ts`, written if-absent so a repo's own file is
  never clobbered). Owner: `backend/src/routes/tasks/CLAUDE.md`.
- **In Progress → Ready to Merge**: the hook hits `POST /api/tasks/:id/complete`
  (idempotent; flips only when the branch has a commit), delivered through the
  callback outbox so a Stop during a backend restart is replayed, not lost
  (`backend/src/routes/tasks/hooks/CLAUDE.md`).
- **Ready to Merge → QA**: `POST /api/tasks/:id/merge` merges main INTO the
  branch *inside the worktree* (main's working tree never gets conflict
  markers; vite stays alive), then fast-forwards main. Clean → `qa`, worktree +
  branch removed. Conflict → `MERGE_INSTRUCTIONS.md` + a resolver Claude in the
  worktree, whose Stop → `/complete` detects the resolved merge and finalizes.
  `/merged` / `/merge-aborted` are explicit fallbacks. Owner:
  `backend/src/worktree/merge/CLAUDE.md`.
- **QA → Done**: manual (drag, or "mark all QA → Done"), or automatic when a QA
  e2e run reports a *confident PASS* (`backend/src/qaRuns/CLAUDE.md`).

## Merge runs (backend-driven "merge all")

Owner: `backend/src/mergeRuns/CLAUDE.md`.

`POST /api/merge-runs {project}` runs every `ready_to_merge` task in
`createdAt` order, continuing past conflicts (resolvers spawned via WS). It
lives in the backend — closing the tab doesn't cancel it; the UI re-syncs via
`GET /api/merge-runs/active`. One run per project (a second start → 409).
Per-task locks (`backend/src/mergeLocks.ts`) keep a manual `/merge` off a task
the run is processing.

The run executes *inside the backend process*, which the dev runner restarts
when a merged task fast-forwards `main` with a `backend/src` change. Two layers
keep "merge all" one-click:

1. The backend dev runner (`backend/scripts/dev.mjs`; deferral in
   `backend/scripts/dev/restartPolicy.mjs`, drain handshake in
   `backend/scripts/dev/restartHandshake.mjs`) doesn't restart while a
   per-project `run.lock` is held. A 15-minute force backstop covers a wedged
   holder and is skipped while the run is parked on a live conflict resolver /
   post-merge hook. The backend is drained before every restart
   (`backend/scripts/dev/CLAUDE.md`, `backend/src/restartDrain/CLAUDE.md`).
2. If a restart happens anyway, boot's `resumeInterruptedMergeRuns`
   (`backend/src/recovery/mergeRunResume.ts`) sees the stale `merge-run` lock
   and restarts a run for what's still `ready_to_merge`.

**So the merge-run logic must stay safely re-runnable** (re-attempts are
idempotent on half-done tasks).

## HTTP / WS surface

The full route map (every HTTP route + WS endpoint, drift-tested) is
`backend/src/routes/ROUTES.md`; per-router detail in
`backend/src/routes/CLAUDE.md`. Every project-scoped route refuses a relative
or drive-relative `project` / `path` / `cwd` with a **400**
(`backend/src/routes/projectParam.ts`), and all WS endpoints share the HTTP
server through one `upgrade` dispatcher (`backend/src/ws/wsServer.ts`).

## Worktree paths

For a repo at `<repoRoot>` (with `<hash>` = `projectHash(repoRoot)`):

- Worktree dir: `~/.lattice/worktrees/<hash>/<slug>-<shortid>` — **outside**
  the project tree (see the `.git`-deletion defences). `git worktree add`
  records the worktree at `<repoRoot>/.git/worktrees/<name>/` regardless of
  where the checkout lives; only that `gitdir` pointer lives in the repo.
  - Legacy: worktrees created before 2026-05-10 are at
    `<repoRoot>/.lattice/worktrees/<slug>-<shortid>`. They keep working (the
    task record stores `worktreePath` explicitly); the boot-time
    `sweepOrphanedWorktrees` (`backend/src/recovery/worktreeSweep.ts`)
    reclaims any that outlive their task.
- Branch: `lattice/<slug>-<shortid>`.
- Task instructions inside the worktree: `LATTICE_TASK.md`.
- Conflict-resolver instructions inside the worktree: `MERGE_INSTRUCTIONS.md`.

## Dev loop

Owner: `scripts/CLAUDE.md`. Root `npm run dev` runs `scripts/devLoop.mjs`
(preflight → `scripts/orchestrate.mjs`, which supervises backend + vite; the
loop relaunches both on a soft restart).

- Dev-console line commands (hint printed at boot): `r` = soft restart (the
  detached terminal-server is kept, so running agents are re-adopted), `d` =
  exit keeping agents running, `i` = re-check/install deps. Ctrl+C is the full
  stop that ends every agent.
- A `package.json` / lockfile change after boot (e.g. a merge) is
  `npm install`ed automatically (`scripts/depsWatch.mjs`).
- The backend refuses to boot (before touching `~/.lattice`) when its code or
  cwd is inside a task worktree, or when another backend holds its port
  (`backend/src/server/bootGuards.ts`; `LATTICE_ALLOW_WORKTREE_BACKEND=1` only
  for an instance with its own HOME and ports).

## E2E isolation

Owner: `e2e/CLAUDE.md`. `npm run test:e2e` never touches the live instance:
`playwright.config.ts` boots an **isolated** backend + vite + terminal-server on
`:5384`/`:5383`/`:5385` with HOME at `<tmp>/lattice-e2e-home`, from the
already-built `backend/dist` (kept current by `npm run dev`, or
`npm --prefix backend run build`).

- Overrides: `LATTICE_E2E_{BACKEND,FRONTEND,TERMINAL}_PORT`, `LATTICE_E2E_HOME`.
- `LATTICE_E2E_BASE_URL` targets an existing server; pointing it at the live
  `:5183`/`:5184` also needs `LATTICE_E2E_ALLOW_LIVE=1`.
- Underlying overrides: backend `PORT`, `TERMINAL_PORT`,
  `LATTICE_FRONTEND_PORT`, `LATTICE_DEFAULT_ROOT`; vite `LATTICE_FRONTEND_PORT`,
  `LATTICE_BACKEND_PORT`, `LATTICE_VITE_CACHE_DIR`.
