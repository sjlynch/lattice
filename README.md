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

## Run

```
npm run dev
```

This runs `scripts/preflight.mjs` (a fast install sanity check that self-heals
a partial install) then `scripts/orchestrate.mjs`, which boots the backend on
`127.0.0.1:5184`, waits for `/api/health`, and then starts the frontend on
`http://localhost:5183`. Open http://localhost:5183.

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

End-to-end (Playwright) — requires the dev server already running:

```
npm run test:e2e
```

The browser suite drives a disposable temporary git project; it does not create
Lattice tasks or workflows in this repository. Set `LATTICE_E2E_BASE_URL` to
target a non-default frontend URL.

## Layout

- `backend/` — TypeScript Node/Express server (`:5184`)
- `frontend/` — Vite + React + TS + xterm + 3d-force-graph (`:5183`)
- `scripts/` — dev orchestration (`orchestrate.mjs`) and preflight
- `e2e/` — Playwright specs
- `docs/` and the root `plan-*.md` files — design notes
- `.lattice/` — per-project scratch (gitignored)

## Where to go deeper

For architecture, the full HTTP/WS surface, the task pipeline, and agent-facing
conventions, see the root [`CLAUDE.md`](./CLAUDE.md) and the per-directory
`CLAUDE.md` / `AGENTS.md` files.
