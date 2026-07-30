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
- `harnesses.test.ts` — the harness-dropdown vocabulary in `harnesses.ts`, the
  single encode/decode source of truth behind every selector (taskboard,
  workflow steps + run overrides, post-merge hook, sidebar tray).
  `isValidPiModel` is the shell-injection guard before a model id reaches
  `pi --approve --model "<x>"`, so it must reject the same corpus as the
  backend `normalizePiModel` (`agentCommandBuilder.ts`) — the one deliberate
  divergence (no trimming) is pinned. Also covers the
  `encodeHarnessValue`/`decodeHarnessValue` round-trip (incl. `pi:` → bare pi
  with NO `piModel` key), `availableHarnessChoices` /`buildHarnessOptions`
  visibility gating (a selected-but-unavailable harness and a saved-but-
  uncurated Pi model must never silently vanish), and the 28-char label
  truncation that keeps the full `provider/model` in `title`.
- `taskColors.test.ts` — `colorForIndex` / `taskColorIndex` / `taskColor`
  (`taskColors.ts`): golden-angle hue walk, mod-3 saturation/lightness band
  cycling, abs+trunc index normalisation, and the deterministic id-hash fallback
  slot. Expected `hsl()` strings are computed from the module constants.
- `copyVariableToken.test.ts` / `promptVariables.test.ts` — the workflow
  variable grammar in `components/workflows/promptVariables.ts`, which must stay
  mirrored to the backend interpolator (`backend/src/workflows/interpolate.ts`).
  `copyVariableToken` covers the clipboard write; `promptVariables` pins the
  editor-overlay grammar: `splitPromptSegments` resets the shared stateful `/g`
  `VAR_TOKEN_RE.lastIndex` per call, captures the trimmed name for inner-
  whitespace tokens (`{{ scope }}`), and keeps invalid token-looking text plain
  (so the overlay never promises a substitution the backend won't perform);
  `withUserInstructions` trims + appends `{{user_instructions}}` exactly once
  (just the token for a blank prompt); `ensureUserInstructions` prepends the
  built-in without duplicating or reordering an existing one.
