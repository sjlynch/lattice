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

## Suites

Pure-helper suites pinning a single source of truth (not exhaustive):

- `searchMatcher.test.ts` — `buildSearchRegExp` (`components/forceGraph/`):
  wildcard→regex translation, metacharacter escaping, case-insensitive matching,
  and the null-on-empty/invalid-regex guard. Must stay in sync with the backend
  matcher in `backend/src/search.ts`.
- `taskColors.test.ts` — `colorForIndex` / `taskColorIndex` / `taskColor`
  (`taskColors.ts`): golden-angle hue walk, mod-3 saturation/lightness band
  cycling, abs+trunc index normalisation, and the deterministic id-hash fallback
  slot. Expected `hsl()` strings are computed from the module constants.
