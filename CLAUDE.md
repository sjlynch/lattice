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
  creates `<repo>-worktrees/<slug>-<id>` on branch `lattice/<slug>-<id>`,
  writes `LATTICE_TASK.md`, and installs a Claude Stop hook in
  `.claude/settings.local.json` that POSTs back to `/complete`.
- `In Progress → Ready to Merge`: the in-worktree Claude finishes; Stop hook
  hits `POST /api/tasks/:id/complete` (idempotent — only flips on first call).
- `Ready to Merge → QA`: ▶ button calls `POST /api/tasks/:id/merge`.
  - Clean merge → status flips to `qa`, worktree + branch removed.
  - Conflict → backend writes `.lattice/merge-<id>.md` with explicit
    instructions and returns `{conflict, command, cwd}`. The UI spawns a
    resolver Claude in the main repo; that Claude curls `/merged` (success)
    or `/merge-aborted` (gave up).
- `QA → Done`: manual drag-and-drop in the UI.

## HTTP / WS surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness probe |
| GET | `/api/default-root` | Default project for the UI |
| GET | `/api/scan?path=` | Recursive source-file scan, gitignore-aware |
| GET | `/api/list-dir?path=` | Folder browser (folder picker) |
| GET | `/api/tasks?project=` | List tasks for a project |
| GET | `/api/tasks/:id` | Fetch a single task |
| POST | `/api/tasks` | Create `{project, title, description?}` |
| PATCH | `/api/tasks/:id` | Update `title` / `description` / `status` |
| DELETE | `/api/tasks/:id` | Remove |
| POST | `/api/tasks/:id/run` | Spawn worktree + Claude on Open task |
| POST | `/api/tasks/:id/complete` | Stop-hook callback (in_progress → ready_to_merge) |
| POST | `/api/tasks/:id/merge` | Attempt git merge; conflict spawns resolver Claude |
| POST | `/api/tasks/:id/merged` | Resolver-Claude callback after a successful merge |
| POST | `/api/tasks/:id/merge-aborted` | Resolver-Claude callback if it gave up |
| WS | `/ws/terminal?cwd=&cols=&rows=` | xterm proxy via node-pty |
| WS | `/ws/tasks?project=` | Live task list updates |

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
- Prefer editing existing files; don't introduce new abstractions for
  one-off tweaks.

## Ports

Frontend `:5183`, backend `:5184` — offset +10 from typical Vite (5173)
to avoid collisions with other local dev servers.

## Worktree paths

For a repo at `<repoRoot>`:

- worktree dir: `<repoRoot>-worktrees/<slug>-<shortid>`
- branch: `lattice/<slug>-<shortid>`
- task instructions inside the worktree: `LATTICE_TASK.md`
- conflict-resolver instructions in the main repo:
  `<repoRoot>/.lattice/merge-<task-id>.md`
