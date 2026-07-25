# frontend

Vite + React + TypeScript frontend package. `src/` is the source of truth;
`frontend/src/CLAUDE.md` is the authoritative navigation doc for the UI code.

## Notes

- `README.md` is a brief package note; `src/CLAUDE.md` is the authoritative
  UI navigation doc.
- Runtime UI is under `src/`; feature subdirectories often carry their own
  `CLAUDE.md` files with local conventions.
- Styling is hand-written CSS under `src/styles/` and aggregated from
  `src/index.css`; do not introduce MUI/styled-components.

## Scripts

- `npm run dev` — Vite dev server; the user owns this process.
- `npm run build` — TypeScript build plus Vite bundle.
- `npm test` — node:test via `tsx` over `src/__tests__/*.test.ts`.

## Validation

- Type-check: `npx tsc -b` from `frontend/`.
- Tests: `npm test` from `frontend/`.
