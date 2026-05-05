# Lattice

Personal coding orchestrator. Manages parallel Claude Code agents in
git-worktree branches and visualizes a project's source tree as a 3D
force-directed DAG.

## Layout

- `backend/` — TypeScript Node.js Express server (`:5184`)
- `frontend/` — Vite + React + TS + xterm + 3d-force-graph (`:5183`)
- `package.json` (root) — `concurrently` runs both via `npm run dev`
- `.lattice/` — per-project state, gitignored: `tasks.json`, `merge-<id>.md`
- `~/.lattice/projects.json` — global index of projects with Lattice tasks

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
  creates `<repo>/.lattice/worktrees/<slug>-<id>` on branch
  `lattice/<slug>-<id>`, writes `LATTICE_TASK.md`, and installs a Claude
  Stop hook in `.claude/settings.local.json` that POSTs back to `/complete`.
- `In Progress → Ready to Merge`: the in-worktree Claude finishes; Stop hook
  hits `POST /api/tasks/:id/complete` (idempotent — only flips on first call).
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

## HTTP / WS surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness probe |
| GET | `/api/default-root` | Default project for the UI |
| GET | `/api/scan?path=` | Recursive source-file scan, gitignore-aware |
| GET | `/api/list-dir?path=` | Folder browser (folder picker) |
| GET | `/api/settings?project=` | Read per-project user settings |
| PATCH | `/api/settings?project=` | Merge-update per-project user settings |
| GET | `/api/tasks?project=` | List tasks for a project |
| GET | `/api/tasks/:id` | Fetch a single task |
| POST | `/api/tasks` | Create `{project, title, description?}` |
| POST | `/api/tasks/batch` | Batch-create `{project, tasks:[{title,description?}]}` — returns array |
| PATCH | `/api/tasks/:id` | Update `title` / `description` / `status` |
| DELETE | `/api/tasks/:id` | Remove |
| POST | `/api/tasks/:id/run` | Spawn worktree + Claude on Open task |
| POST | `/api/tasks/:id/complete` | Stop-hook callback (in_progress → ready_to_merge) |
| POST | `/api/tasks/:id/merge` | Attempt git merge; conflict spawns resolver Claude |
| POST | `/api/tasks/:id/merged` | Resolver-Claude callback after a successful merge |
| POST | `/api/tasks/:id/merge-aborted` | Resolver-Claude callback if it gave up |
| POST | `/api/merge-runs` | Body `{project}` — start a merge-all run |
| GET | `/api/merge-runs/active?project=` | Active run for a project, or `null` |
| GET | `/api/merge-runs/:id` | Run snapshot |
| POST | `/api/merge-runs/:id/cancel` | Request cancellation (run finishes current task and stops) |
| POST | `/api/workflows/:id/run` | Start a workflow run (spawns step 0 terminal) |
| POST | `/api/workflow-runs/:runId/steps/:n/complete` | Stop-hook callback — advances to next step |
| GET | `/api/workflow-runs/active?project=` | Active workflow runs for a project |
| GET | `/api/terminals` | Debug: list active pty sessions |
| DELETE | `/api/terminals/:id` | Kill a pty session |
| WS | `/ws/terminal?id=&cwd=&cols=&rows=&initialCommand=` | xterm proxy via node-pty (with replay) |
| WS | `/ws/tasks?project=` | Live task list updates |
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

## Ports

Frontend `:5183`, backend `:5184` — offset +10 from typical Vite (5173)
to avoid collisions with other local dev servers.

## Worktree paths

For a repo at `<repoRoot>`:

- worktree dir: `<repoRoot>/.lattice/worktrees/<slug>-<shortid>` (inside
  the gitignored `.lattice/` folder so it stays self-contained)
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
