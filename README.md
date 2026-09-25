# Lattice

Lattice is a personal coding orchestrator. It manages parallel coding agents
(Claude Code / Codex / Pi) in git-worktree branches and visualizes the active
project's source tree as a 3D force-directed graph, so you can drive many
agents at once and watch what they touch.

This README is a compact orientation for newcomers and coding agents. For the
architecture, the full HTTP/WS surface, the task pipeline, and agent-facing
conventions, see the root [`CLAUDE.md`](./CLAUDE.md) and the per-directory
`CLAUDE.md` / `AGENTS.md` files rather than duplicating them here.

## Install

First time (installs the root, backend, and frontend workspaces):

```
npm run install:all
```

After a `git pull` you can go straight to `npm run dev`: its preflight
compares every dependency each workspace declares (and the version its
`package-lock.json` pins) with what is in `node_modules`, and re-runs
`install:all` when a pull added or bumped a package.

## Run

```
npm run dev
```

This runs `scripts/devLoop.mjs`: `scripts/preflight.mjs` (a fast install
sanity check that self-heals a partial or out-of-date install), then
`scripts/orchestrate.mjs`, which boots the backend on `127.0.0.1:5184`, waits
for `/api/health`, and then starts the frontend on `http://localhost:5183`.
Open http://localhost:5183.

The dev console takes line commands: `r` soft restart (relaunches preflight +
orchestrator from current scripts/deps; running agents are re-adopted), `d`
exit but keep agents running, `i` re-check/install deps, `h` help. Ctrl+C is
the full stop that ends every agent.

Ports are offset +10 from the typical Vite default (5173) to avoid collisions
with other local dev servers.

## Type-check

```
cd backend && npx tsc --noEmit
cd frontend && npx tsc -b
```

## Tests

Unit tests (node:test via `tsx` over each workspace's `src/__tests__/*.test.ts`):

```
npm --prefix backend test
npm --prefix frontend test
```

End-to-end (Playwright):

```
npm run test:e2e
```

It boots its own isolated backend + vite + terminal-server (`:5384`/`:5383`/`:5385`,
HOME at `<tmp>/lattice-e2e-home`, override with `LATTICE_E2E_HOME`) from the
already-built `backend/dist`, so it needs a built backend
(`npm --prefix backend run build`, or a running `npm run dev`, whose `tsc -w`
keeps `dist` current) and errors if `backend/dist/index.js` is missing. Specs
that create real tasks/workflows write only into that isolated home, never your
`~/.lattice`. `LATTICE_E2E_BASE_URL` targets an existing server instead;
pointing it at the live `:5183`/`:5184` also needs `LATTICE_E2E_ALLOW_LIVE=1`.

## Layout

- `backend/` — TypeScript Node/Express server (`:5184`)
- `frontend/` — Vite + React + TS + xterm + 3d-force-graph (`:5183`)
- `scripts/` — the `npm run dev` loop (`devLoop.mjs` → `preflight.mjs` → `orchestrate.mjs` + `orchestrate/`), dependency checks/watch (`depsCheck.mjs`, `depsWatch.mjs`), and the self-hosting soak (`soak/`); see `scripts/CLAUDE.md`
- `e2e/` — Playwright specs
- `docs/` and the root `plan-*.md` files — design notes
- `.lattice/` — per-project scratch (gitignored)

## Where to go deeper

For architecture, the full HTTP/WS surface, the task pipeline, and agent-facing
conventions, see the root [`CLAUDE.md`](./CLAUDE.md) and the per-directory
`CLAUDE.md` / `AGENTS.md` files.
