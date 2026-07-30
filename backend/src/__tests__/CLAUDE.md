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
- `waiterLiveness.test.ts` — `awaitResolverWaiter` bounded-lifetime backstop for
  a parked merge-run conflict waiter: signal wins, a vanished resolver pty
  releases as `resolver-dead` after consecutive strikes, an interleaved "can't
  tell" resets the strike count, the wall-clock cap yields `timeout`, and the
  synchronous-registration ordering the park sites depend on holds. Uses a
  virtual-clock + fake `listSessions` deps seam (no real timers/terminal-server).
- `mergeRunConflictPark.test.ts` — `parkOnConflictResolver` drops the per-task
  merge lock before waiting and still resumes on a signal that races the await
  (guards the resolver-finalize deadlock).
- `mergeAbortedAuthoritative.test.ts` — `/merge-aborted` is authoritative: a late
  `/merged` from an abandoned resolver no-ops (conflict-flag gate), AND a
  merge-run worker parked on the conflict waiter is released so the project
  run-lock is freed (Part A of the parked-waiter wedge fix).
- `cleanupSafety.test.ts` — the two `.git`-deletion throw-guards in
  `worktree/cleanupSafety.ts`: `assertSafeWorktreePath` (empty/whitespace path,
  the repo root, out-of-bounds and wrong-project paths, the managed base dir
  itself; accepts home + legacy worktree paths) and `assertNotReparsePoint`
  (no-op on real files/dirs, silent on ENOENT, throws on a junction and on a
  path reached *through* one — the branch lstat alone can't catch). Temp-dir
  fixtures use `fs.symlink(…, 'junction')` like `pruneReparsePoints.test.ts`.
