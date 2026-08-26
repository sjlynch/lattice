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
- `gitSetupDerive.test.ts` — the pure core of Git Setup
  (`components/gitSetup/gitSetupDerive.ts`). `deriveGitChipState` IS the
  contract's navbar-chip table, so the assertions mirror it row for row: a
  missing probe degrades to the pre-feature branch chip (never guesses "No
  Git"), `none` + `initable` is the only clickable state and is labelled with a
  verb, and `nested` renders an inert warning chip naming the ancestor repo —
  init must never be offered there. Also pins `formatBytes` / `formatFileCount`
  (a `truncated` walk renders `20,000+`, a floor rather than a count) and
  `describeProbeBlocker`'s refusal copy.
- `ghostLinkSync.test.ts` — `applyChangeRingDelta`'s ghost handling
  (`components/forceGraph/changeRingSync.ts`). The delta deliberately skips the
  library digest, so it owns ghost visibility across BOTH link renderers: pins
  that scrubbing a deleted file out of the window hides the per-link `__lineObj`
  and drops the segment from the batched `LineSegments` buffer (the "grey node
  vanished but its line didn't" bug), that scrubbing back restores both, and that
  a ghost with no mounted object falls back to a refresh only when it should be
  showing.
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
- `startupTerminalProjectSwitch.test.ts` — the one React-rendering suite here
  that exists for a *spawn* rather than a value. Drives the real
  `useUserSettings` + `useStartupTerminalSync` through a project switch with the
  new project's settings fetch held open, alongside a stand-in for Sidebar's
  spawn effect (keyed on `activeFolder`, launching each command with cwd = the
  currently-active folder). Pins that no commit ever pairs one project's folder
  with another's commands: before the fix, `useUserSettings` flipped to
  "loading" from an effect — which runs *after* the render that changed
  `activeFolder` — so for one commit consumers saw `loaded: true` beside the
  previous project's settings, and the spawn effect fired with the new cwd and
  the old commands (apply_digital's `npx next dev` running in interview_eci).
  Asserts the leak is gone, that the new project still ends up running exactly
  its own startup terminal once its settings land, and that clearing the project
  empties the list.
