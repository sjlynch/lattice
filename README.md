# Lattice

Lattice is a personal coding orchestrator. It manages parallel coding agents
(Claude Code / Codex / Pi) in git-worktree branches and visualizes the active
project's source tree as a 3D force-directed graph, so you can drive many
agents at once and watch what they touch.

This README is a compact orientation for newcomers and coding agents. For the
architecture, the full HTTP/WS surface, the task pipeline, and agent-facing
conventions, see the root [`CLAUDE.md`](./CLAUDE.md) and the per-directory
`CLAUDE.md` / `AGENTS.md` files rather than duplicating them here.

## Prerequisites

- Node.js matching `^20.19.0 || ^22.13.0 || >=24` (20.19+ within 20.x,
  22.13+ within 22.x, or 24+), with its bundled npm on `PATH`. This range
  comes from the committed `package-lock.json` files: ESLint 10 is stricter
  than Vite's Node 22.12 minimum. Locked Rollup also requires npm >=8.
- Git installed and on `PATH` for project repositories and task worktrees.
- For agent work, at least one supported harness installed and on `PATH`:
  Claude Code (`claude`), Codex (`codex`), or Pi (`pi`). Authenticate it with
  your chosen provider and verify it works in your terminal before using it
  in Lattice; `install:all` does not install or authenticate these CLIs.

## Install

First time (installs the root, backend, and frontend workspaces):

```
npm run install:all
```

After a `git pull` you can go straight to `npm run dev`: its preflight
compares every dependency each workspace declares (and the version its
`package-lock.json` pins) with what is in `node_modules`, and re-runs
`install:all` when a pull added or bumped a package.

## Another PC

To let Fleet see and drive a second Windows PC (say, one with a GPU for local
models), run this in PowerShell on that PC, then follow the steps it prints
(start Lattice there, turn on its gateway in Fleet → PCs, create an invite and
paste it on this PC):

```
irm https://raw.githubusercontent.com/sjlynch/lattice/main/scripts/setup-peer.ps1 | iex
```

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

## Security findings in the graph

Install Opengrep and a rule pack in Settings → Tools, then click the graph's
Security chip to scan. Hover a file for a preview; click it for that file's
findings, or click the findings count to browse all results. The panel supports
search, severity/category filters, file/rule grouping, snippets, references,
VS Code line links and highlighting a file in the graph. **View findings** opens
a resizable/maximizable window with continuously scrolling rows and a detail
pane. Its Open/Ignored/Deferred filter keeps triage separate from severity;
the Settings severity floor applies until you opt into lower-severity findings.

Choose a harness and scope, then **Start review** to discuss findings with Claude,
Codex or Pi in its console. Selecting findings automatically chooses **Selected
open**; the start button shows the exact count. A current scan is required.
The harness explains its evidence and recommends a short menu of next steps,
then waits for your reply. Nothing is filed or changed by starting the review.
After you choose, agreed fixes/investigations become grouped Open tasks for you
to review and run through the normal worktree pipeline. Unfixable risks and
false positives are discussed separately, without silently ignoring them.

**Open console** returns to the conversation after a refresh. Lattice retains
session metadata and uses normal terminal conversation recovery; recommendations
stay in the harness conversation, with no separate report or Apply UI.
**End review** closes the console; previously agreed tasks remain on the board.
The initial brief prohibits edits and executing project code; Codex additionally
uses a scratch workspace sandbox. Existing legacy report files are left untouched
but no longer displayed or updated.

Local ignores require a reason, preserve history and can be undone. Deferred
risks also require an owner and a future review date; expired exceptions reopen.
These dispositions affect Lattice's graph/digests, not CI. **Shared with
repository / CI** creates a review task proposing a rule-specific `nosemgrep`
comment and verifying CI uses compatible rule IDs and honors source
suppressions (without `--disable-nosem`). It preserves other rule coverage.
Native source suppressions and legacy Settings ignores remain identifiable in
the viewer; remove them in source/Settings to reopen them. The engine may omit
native suppressed findings entirely, so the Ignored filter is not an exhaustive
inventory of every suppression in the repository.

Saved results return after refresh. The chip toggles the saved view; its adjacent
scan menu and the findings panel offer **Update changed files** and **Full scan**.
Updates reuse unchanged files when their content and scan configuration match;
the first update of an older scan establishes a full cache baseline. Freshness
and coverage are shown separately, so unscanned, incomplete or stale files
remain gray. During a scan the graph and previous results stay available;
clicking the spinning chip cancels it. Refresh reconnects to the running scan
and its estimated countdown.

## Build

From the repository root (there is no root `npm run build` script):

```
npm --prefix backend run build
npm --prefix frontend run build
```

These generate `backend/dist` (compiled server code and copied runtime assets)
and `frontend/dist` (the frontend bundle). Both are generated outputs; edit
the source files and rebuild instead of editing `dist`.

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

End-to-end (Playwright) uses the `chromium` project in
[`playwright.config.ts`](./playwright.config.ts). After `install:all`,
[install its browser](https://playwright.dev/docs/browsers#install-browsers)
before the first run; npm installation alone does not download Chromium:

```
npx playwright install chromium
```

Then run the suite:

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
- `docs/` — on-demand agent docs: `ARCHITECTURE.md` (on-disk state, task pipeline, merge runs, worktrees, dev loop), `RECIPES.md` (touch points for common changes), `MANUAL_TESTING.md`
- `.lattice/` — per-project scratch (gitignored)

## Where to go deeper

Agent-facing rules live in the root [`CLAUDE.md`](./CLAUDE.md) and the
per-directory `CLAUDE.md` files; architecture in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); the HTTP/WS surface in
[`backend/src/routes/ROUTES.md`](./backend/src/routes/ROUTES.md).
