# frontend/src/__tests__

Frontend tests also use Node's built-in `node:test` runner with `tsx`
(`npm test` from `frontend/`). They are mostly pure TS/React-state tests, not a
browser/Vite integration suite.

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- Keep DOM/window shims local and reusable; `domDoubles.ts` holds shared doubles.
- Prefer testing extracted pure helpers/hooks adapters over mounting large UI
  trees. When React rendering is needed, use the existing lightweight patterns
  in nearby tests.
- Avoid depending on the Vite dev server or real backend; stub API/WS boundaries.
