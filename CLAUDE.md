# Lattice

Personal coding orchestrator. Manages parallel Claude Code agents in
git-worktree branches and visualizes a project's source tree as a 3D
force-directed DAG.

## Layout

- `backend/` — TypeScript Node.js Express server (`:5184`)
- `frontend/` — Vite + React + TS + xterm + 3d-force-graph (`:5183`)
- `package.json` (root) — `concurrently` runs both via `npm run dev`
- `<project>/.lattice/` — per-project scratch (gitignored): `workflow-steps/`, `workflows.json`, `userSettings.json`, `health-cache.json`. **No longer holds `worktrees/` or push-run scratch** — those moved to home-scoped locations (see below). Tasks live in `~/.lattice/per-project/<hash>/tasks.json`.
- `~/.lattice/projects.json` — global index of projects with Lattice tasks
- `~/.lattice/per-project/<sha1(path)[:12]>/tasks.json` — task DB per project. Moved out of `<project>/.lattice/tasks.json` after the 2026-05-09 catastrophic-deletion incident; legacy in-project files auto-migrate on first read. `run.lock` here is the cross-process per-project merge lock.
- `~/.lattice/per-project/<sha1(path)[:12]>/push/<id>/` — per-push-run Claude scratch (`PUSH_INSTRUCTIONS.md` + Stop hook). Recursive cleanup is path-guarded to this home root and refused if it would land under the repo.
- `~/.lattice/worktrees/<projectHash>/<slug>-<id>/` — per-task git worktree checkout. **Outside the project tree on purpose** (2026-05-10): nesting them inside `<repo>/.lattice/` was the root of three `.git`-deletion incidents (a bad recursive-delete path, or `git status` enumerating the nested checkouts). The only thing left inside `<repo>/.git` is the small `worktrees/<name>/gitdir` pointer.
- `~/.lattice/snapshots/<projectHash>/<ts>-<label>/` — copy-based working-tree snapshot (replaces `git stash --include-untracked`, which had a silent-data-loss failure mode). Orphan snapshots from a crashed run are restored on next boot via `recoverPendingSnapshots`.
- `~/.lattice/git-backups/<projectHash>/<ts>.bundle` — `git bundle --all` snapshot taken before each merge run; last 5 kept. Last-resort full-history recovery if `.git` is ever damaged: `git fetch <bundle>`.

### `.git`-deletion defences (read before touching the merge pipeline)

Every prior incident traced to a recursive filesystem delete reaching `.git` (directly via `fs.rm`, or via a lost `git stash --include-untracked`). Layered defences, outermost first: (1) worktrees and push-run scratch live outside the project tree; (2) `projectGit()` — all git against the project repo goes through a wrapper that whitelists subcommands (no `clean`/`stash`/`reset --hard`/`update-ref -d`/non-ff `merge`/`branch -D <non-lattice>`/`checkout <branch>`/…); (3) no raw `fs.rm` fallback in worktree cleanup — recursive removal is delegated to `git worktree remove`; (4) `pruneReparsePointsUnder` strips any junction/symlink before recursive scratch removal paths so neither git's recursion nor Lattice's `fs.rm` can walk a reparse-point loop (an in-worktree `npm install` of a `file:..` self-dep was the realistic source — and `backend`/`frontend` no longer carry that self-dep); (5) copy-based snapshots, never `git stash`; (6) a run circuit breaker that halts the whole merge run if `.git` vanishes or HEAD moves non-forward between tasks; (7) the `git bundle` backup above; (8) `assertNotReparsePoint` on the remaining `fs.rm` sites, snapshot-manifest path validation, guarded push-run cleanup, and a cross-process project run lock. See `backend/src/worktree/CLAUDE.md`.

## Run

```
npm run dev
```

**Do not start, stop, or restart the dev server yourself.** The user runs it
in their own terminal and watches the output for errors. Restarting it from
inside Claude steals their console, drops their HMR/WS connections, and
hides errors they were already debugging. Type-check via `tsc` to validate
your changes — the user will reload the running server when they're ready.

Type-check:
- backend: `cd backend && npx tsc --noEmit`
- frontend: `cd frontend && npx tsc -b`

## Task pipeline

```
Open ──▶── In Progress ──▶── Ready to Merge ──▶── QA ──▶── Done
                                                          (Deleted bin)
```

- `Open → In Progress`: ▶ button calls `POST /api/tasks/:id/run`. Backend
  creates `~/.lattice/worktrees/<projectHash>/<slug>-<id>` on branch
  `lattice/<slug>-<id>`, writes `LATTICE_TASK.md`, and installs a Claude
  Stop hook in `.claude/settings.local.json` that POSTs back to `/complete`.
  The Stop hook is always installed (a Pi/Codex task that later conflicts is
  resolved by a *Claude* resolver, which needs it). For a Pi-run task it also
  writes a `.pi/extensions/lattice-complete.ts` extension that POSTs
  `/complete` on `session_shutdown` — Pi's analogue of the Stop hook — and
  `LATTICE_TASK.md` is reworded so the model curls `/complete` itself as its
  final step (the extension is the backstop if it forgets).
- `In Progress → Ready to Merge`: the in-worktree agent finishes; the Stop
  hook (Claude) / completion extension (Pi) / explicit curl in
  `LATTICE_TASK.md` hits `POST /api/tasks/:id/complete` (idempotent — only
  flips on first call, and only when the branch has a commit).
- `Ready to Merge → QA`: ▶ button calls `POST /api/tasks/:id/merge`.
  Backend merges main INTO the branch *inside the worktree* (so main's
  working tree never has conflict markers and vite stays alive), then
  fast-forwards main on success.
  - Clean merge → status flips to `qa`, worktree + branch removed.
  - Conflict → backend writes `MERGE_INSTRUCTIONS.md` inside the worktree
    and returns `{conflict, command, cwd}`. The UI spawns a resolver
    Claude in the worktree. When that Claude finishes (commit + Stop),
    the worktree's existing Stop hook calls `/complete`, which detects
    the resolved merge and finalizes (FF main + cleanup). `/merged` and
    `/merge-aborted` are also exposed as explicit fallbacks.
- `QA → Done`: manual drag-and-drop in the UI, or "mark all QA → Done"
  button on the QA lane.

### Merge runs (backend-driven "merge all")

`POST /api/merge-runs {project}` starts a backend run that iterates every
`ready_to_merge` task in `createdAt` order. The run continues past
conflicts (per-task `conflict: true` flag is set; resolver Claude is
spawned via the WS). Closing the browser tab does NOT cancel the run —
it keeps progressing on the backend; on reopen the UI re-syncs via
`GET /api/merge-runs/active?project=`. One active run per project; a
second start returns 409. Cancel via `POST /api/merge-runs/:id/cancel`.
Per-task in-process locks (`mergeLocks.ts`) prevent a manual `/merge`
click landing on the same task while the run is processing it.

The run executes *inside the backend process*. In dev that process gets
restarted by `tsc -w` + the dev runner whenever a merged task
fast-forwards `main` with a `backend/src` change — which would kill the
run. Two layers keep "merge all" a one-click operation anyway: (1)
`scripts/dev.mjs` doesn't restart the backend while a per-project
`run.lock` is held (it defers until the run finishes); (2) if a restart
happens regardless (a crash, or `dev.mjs` isn't the one running it), the
next boot's `resumeInterruptedMergeRuns` spots the stale `merge-run`
`run.lock` and starts a fresh run for whatever's still `ready_to_merge`
(re-attempts are idempotent on half-done tasks). The merge-run logic must
therefore stay safely re-runnable.

## HTTP / WS surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness probe |
| GET | `/api/default-root` | Default project for the UI |
| GET | `/api/scan?path=` | Recursive source-file scan, gitignore-aware |
| GET | `/api/list-dir?path=` | Folder browser (folder picker) |
| GET | `/api/settings?project=` | Read per-project user settings |
| PATCH | `/api/settings?project=` | Merge-update per-project user settings |
| GET | `/api/project-env?project=` | Auto-detected package-manager envs + the "fresh worktree, don't reinstall" notes (default + effective) |
| GET | `/api/tasks?project=` | List tasks for a project |
| GET | `/api/tasks/:id` | Fetch a single task |
| POST | `/api/tasks` | Create `{project, title, description?}` |
| POST | `/api/tasks/batch` | Batch-create `{project, tasks:[{title,description?}]}` — returns array |
| PATCH | `/api/tasks/:id` | Update `title` / `description` / `status` |
| DELETE | `/api/tasks/:id` | Remove |
| POST | `/api/tasks/:id/run` | Enqueue an Open task's run on the spawn queue; returns `{accepted, queued}` (pty delivered later via the `task-spawned` WS event) |
| POST | `/api/tasks/:id/resume` | Enqueue a re-spawn in the existing worktree; returns `{accepted, queued}` |
| POST | `/api/tasks/:id/complete` | Stop-hook callback (in_progress → ready_to_merge) |
| POST | `/api/tasks/:id/merge` | Attempt git merge; conflict pre-creates resolver pty, returns `serverId` |
| POST | `/api/tasks/:id/merged` | Resolver-Claude callback after a successful merge |
| POST | `/api/tasks/:id/merge-aborted` | Resolver-Claude callback if it gave up |
| POST | `/api/merge-runs` | Body `{project}` — start a merge-all run |
| GET | `/api/merge-runs/active?project=` | Active run for a project, or `null` |
| GET | `/api/merge-runs/:id` | Run snapshot |
| POST | `/api/merge-runs/:id/cancel` | Request cancellation (run finishes current task and stops) |
| POST | `/api/workflows/:id/run` | Start a workflow run (spawns step 0 terminal) |
| POST | `/api/workflow-prompt-customizations` | Spawn selected harness to tailor a workflow step prompt |
| GET | `/api/workflow-prompt-customizations/:id` | Poll prompt-customization status/result |
| POST | `/api/workflow-prompt-customizations/:id/complete` | Harness callback with customized prompt |
| POST | `/api/workflow-runs/:runId/steps/:n/complete` | Stop-hook callback — advances to next step |
| GET | `/api/workflow-runs/active?project=` | Active workflow runs for a project |
| GET | `/api/terminals` | Debug: list active pty sessions |
| DELETE | `/api/terminals/:id` | Kill a pty session |
| GET | `/api/spawn-queue` | Debug: spawn-queue snapshot (pending/in-flight/reserved, softCap) |
| WS | `/ws/terminal?id=&cwd=&cols=&rows=&initialCommand=` | xterm proxy via node-pty (with replay) |
| WS | `/ws/tasks?project=` | Live task list updates + `task-spawned` events (a queued run's pty spawned) |
| WS | `/ws/merge-runs?project=` | Run progress + per-conflict resolver spawn events |

Both WS endpoints share the HTTP server via a single `upgrade` dispatcher
(`noServer: true`); routing by `pathname` so multiple WSs can coexist.

## Conventions

- **No MUI.** UI is hand-written CSS in `frontend/src/index.css` plus
  `lucide-react` icons.
- **Sprite shapes/colors per file extension** are defined in
  `frontend/src/extensionStyles.ts` — single source of truth shared by the
  3D graph and the Legend overlay. To add a language, add an entry there.
- **Tasks store** is in-memory keyed by project path with debounced JSON
  persistence; the global `~/.lattice/projects.json` index is consulted
  lazily so Stop-hook callbacks resolve task IDs across sessions.
- **3d-force-graph** uses OrbitControls (not Trackball) with `camera.up`
  locked to +Y and polar clamped to `[0, 0.75π]`. DAG mode `td`. Sprites
  are canvas-rendered with `tex.colorSpace = SRGBColorSpace` so colors
  match the legend exactly. Filtering goes through `nodeVisibility` /
  `linkVisibility` to keep the simulation stable.
- **Per-project filter / panel state** is persisted under
  `lattice.<thing>.<projectPath>` keys in `localStorage`.
- **Per-project user settings** (e.g., sidebar width) are stored in
  `<project>/.lattice/userSettings.json` via `GET /api/settings?project=` and
  `PATCH /api/settings?project=`. The `UserSettings` type lives in
  `backend/src/userSettings.ts`; frontend helpers are in `frontend/src/api.ts`.
- Prefer editing existing files; don't introduce new abstractions for
  one-off tweaks.
- **Terminal pty pre-spawn.** When a task/workflow/conflict spawn would
  produce a UI terminal, the backend pre-creates the pty via the
  terminal-server's `POST /sessions` and ships back a `serverId`. The
  frontend stores it on the `TerminalSpec` and lazy-mounts the
  `<TerminalPane>` only on first activation. This keeps "Run All" from
  blowing past Chrome's per-page WebGL context cap, since each xterm
  WebglAddon allocates its own context.

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
    "description": "in frontend/src/api.ts at the top of the file, add a comment `// version 1.0.1` (replacing any existing version comment)."
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
`frontend/src/api.ts`:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST http://127.0.0.1:5184/api/tasks \
    -H "Content-Type: application/json" \
    -d "{
      \"project\": \"C:\\\\development\\\\lattice\",
      \"title\": \"version stamp ${i}\",
      \"description\": \"At the very top of frontend/src/api.ts, add or replace a single line that reads exactly: // lattice-test-stamp: ${i}. Do not edit anything else in the file.\"
    }"
done
```

After seeding, click "Run All" on the Open lane to spawn worktree
Claudes, then "Merge All" on Ready-to-Merge. The first merge will land
clean; subsequent ones should hit a one-line conflict on the stamp,
trigger a resolver Claude in each worktree, and (assuming the resolver
just keeps the incoming side) finalize automatically.
