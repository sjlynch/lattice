# backend/src/__tests__

Backend tests use Node's built-in `node:test` runner with `tsx` for TypeScript
execution (`npm test` from `backend/`). Keep tests as plain `.test.ts` files in
this directory unless a helper belongs under `helpers/`.

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- Prefer focused pure-unit coverage; use temp dirs from `helpers/tempDir.ts` for
  filesystem tests and clean them in `t.after`/`finally`.
- Tests run in one Node process against source files; avoid global mutable state
  leaks, real dev-server dependencies, or long-lived timers.
- When testing route handlers, build the router/app in-process rather than
  starting the backend server.
