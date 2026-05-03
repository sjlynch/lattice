# backend/src

Express server (`:5184`) plus a detached PTY subprocess on `:5185`.

## Layout

- `index.ts` — bootstrap. Mounts route modules from `routes/`, attaches WS via `ws/wsServer.ts`, runs `recovery.ts` before listen.
- `routes/` — one router per domain (tasks, mergeRuns, workflows, settings, terminals, health). Each is a `buildXRouter()` factory.
- `ws/wsServer.ts` — single `upgrade` dispatcher. Adding a WS endpoint = add a route in `attachWebSockets`.
- `worktree/` — git-worktree subsystem (see its `CLAUDE.md`). The `worktree.ts` shim re-exports the public surface.
- `tasks.ts` — in-memory cache + 100 ms debounced persist; per-project `.lattice/tasks.json`. `updateTaskCrashSafe` writes to disk before mutating cache.
- `mergeRuns.ts` / `workflowRuns.ts` — sequential run engines. Singleton WS subscribers (`subscribe`) for live event fan-out.
- `terminalProxy.ts` / `terminal-server.ts` / `terminal.ts` — PTY lives in a detached child so main-server restarts don't kill running Claude sessions.
- `processGuards.ts` — swallows node-pty's known Windows cleanup throw; everything else logs and continues.

## Key invariants

- **One active merge run per project** (mergeRuns.ts) — second start returns 409.
- **Per-task merge lock** (`mergeLocks.ts`) — manual /merge can't race the run worker.
- **Crash-safe ordering**: `updateTaskCrashSafe` writes disk before cache. Used for `ready_to_merge → qa` transitions.
- **Merge in worktree, not main** — see `worktree/merge.ts`. Main's tree only ever changes via fast-forward.

## Type-check

`npx tsc --noEmit` from `backend/`. Tests: `npm test` (node:test, runs `src/__tests__/*.test.ts`).
