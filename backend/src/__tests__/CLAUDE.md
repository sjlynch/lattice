# backend/src/__tests__

Backend tests use Node's built-in `node:test` runner with `tsx` for TypeScript
execution (`npm test` from `backend/`). The `test` script `--import`s
`helpers/isolateHome.mjs` first, redirecting `HOME`/`USERPROFILE` to a throwaway
temp dir so the suite never writes into the real `~/.lattice` (task DBs,
`projects.json`, snapshots) — it must load before any test imports the task
cache, whose home path binds once at module load. Keep tests as plain
`.test.ts` files in this directory unless a helper belongs under `helpers/`.

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- Prefer focused pure-unit coverage; use temp dirs from `helpers/tempDir.ts` for
  filesystem tests and clean them in `t.after`/`finally`.
- Tests run in one Node process against source files; avoid global mutable state
  leaks, real dev-server dependencies, or long-lived timers.
- When testing route handlers, build the router/app in-process rather than
  starting the backend server.

## Suite index

- `agentCommandBuilder.test.ts` — `buildAgentCommand()` harness framing
  (claude/pi/codex) + its private `shellDoubleQuoted()` prompt-quoting guard
  (double-quote/backslash/dollar/backtick each escaped once; injection prompts
  neutralised). Pure unit test, no spawning.
- `worktree.merge.branchState.test.ts` — `checkBranchState()` merge state
  machine across all four outcomes (error/already-merged/empty/ahead); pins the
  safety invariant that a THROWN commit-count surfaces as `error` (never a
  silent empty/already-merged), stubbing the `../state.js` git reads via the
  module's injectable deps seam.
