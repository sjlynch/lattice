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
- `npm run build` — `tsc` then `scripts/copy-assets.mjs` for non-TS runtime
  assets that must exist under `dist/`.
- `npm test` — node:test via `tsx` over `src/__tests__/*.test.ts`.

## Validation

- Type-check: `npx tsc --noEmit` from `backend/`.
- Tests: `npm test` from `backend/` (target a single test with Node's
  `--test-name-pattern` when useful).
