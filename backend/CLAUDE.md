# backend

Node/Express backend package. Runtime code lives in `src/`; compiled output in
`dist/` is generated and should not be edited.

## Source of truth

- `src/` is the authoritative implementation and local navigation root.
- `src/CLAUDE.md` describes the backend module layout in detail.
- `dist/` is produced by TypeScript/build scripts and may be stale in a
  worktree; fix `src/` and rebuild rather than patching emitted JS.

## Scripts

- `npm run dev` — backend dev loop (`scripts/dev.mjs`); do not start it from
  an agent session unless explicitly asked.
- `npm run build` — `tsc` then `scripts/copy-assets.mjs` (see below).
- `npm test` — node:test via `tsx` over `src/__tests__/*.test.ts`.

## Validation

- Type-check: `npx tsc --noEmit` from `backend/`.
- Tests: `npm test` from `backend/` (target a single test with Node's
  `--test-name-pattern` when useful).

## Non-TS runtime assets

`tsc` only emits `.js` for `.ts`. Runtime assets under `src/`
(`workflowRuns/create-task-template.cjs`, `latticeApiDocs/LATTICE_API.template.md`,
`latticeApiDocs/LATTICE_API_RECIPES.template.md`) are copied into `dist/` by
`scripts/copy-assets.mjs`, which runs from **both** `npm run build` and the dev
loop (right after its initial `tsc`). New asset → add it to that one list.
A missing helper asset crashes boot (`ENOENT … dist/…`: `renderHelperScript.ts`
reads it synchronously at module load); a missing API-doc template only
disables that doc's generation (warned once, never blocks a spawn).

## Dependencies

The `express` dependency override keeps its `qs` dependency at `>=6.16.0`
within major version 6. Express 4 currently pins older vulnerable minor
versions; remove the override once its declared range permits the patched
release. Keep Express 4 while `express-async-errors` provides async route
handling, and verify dependency updates with `npm audit` and the HTTP tests.
