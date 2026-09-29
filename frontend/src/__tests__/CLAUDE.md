# frontend/src/__tests__

Frontend tests also use Node's built-in `node:test` runner with `tsx`.
They are mostly pure TS/React-state tests, not a browser/Vite integration suite.
Commands from `frontend/` (reference only): `npm test` (tests), `npx tsc -b`
(type-check), `npm run build` (build).

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- Keep DOM/window shims local and reusable; `domDoubles.ts` holds shared doubles.
- Prefer testing extracted pure helpers/hooks adapters over mounting large UI
  trees. When React rendering is needed, use the existing lightweight patterns
  in nearby tests.
- Avoid depending on the Vite dev server or real backend; stub API/WS boundaries.

## Suites

Selected suites and the contracts they own (not exhaustive):

- `terminalCloseRecovery.test.ts` / `terminalCleanupAtomic.test.ts` — registered
  close confirmation, retained PTY ownership on failure, explicit retry, and
  functional bulk removals. Render the provider with the real task-cleanup hook
  to pin stable renders/one DELETE while pending, failed closes without automatic
  retry, mixed registered/fallback cleanup, resolver eligibility, and late tabs.
- `terminalRegistrySync.test.ts` / `useTerminalRegistrySync.test.ts` — pure
  reconciliation and rendered provider/hook coverage for late registry HTTP
  responses. Deferred lists/restores and a controlled WS stream pin newer pty
  identities, failures, removals, remote/local additions, project-switch
  cancellation, and the Sidebar's pane status/remount behavior. Restore summaries
  still mark queued tabs pending when queue events were missed.
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
  (`components/gitSetup/gitSetupDerive.ts`). `deriveGitChipState` has two
  actionable cases: `none` + `initable=true` ("Set up Git") and `repo` +
  `unborn=true` + `initable=true` ("finish setup"). A missing probe falls back
  to the pre-feature branch chip, or nothing (never guesses "No Git").
  `nested` renders an inert warning naming the ancestor repo — init must never
  be offered there. Also pins `formatBytes` / `formatFileCount` (truncated
  counts are floors) and `describeProbeBlocker`'s refusal copy.
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
- `backendRestartResilience.test.ts` — React hook/adapter tests rendering the real
  `useWorkflowRunActions` and `useTaskLifecycleActions` (Resume uses
  `GitSetupProvider` + `TerminalsProvider`). Keep HTTP acknowledgements deferred
  and timing/WS boundaries controlled (`installManualTimers`, `FakeWebSocket`);
  this is not a real-backend browser suite. Pins safe retries of known-unaccepted
  `503`/`ECONNREFUSED` requests; ambiguous workflow starts/resumes must not allocate
  again after server-side completion, cancellation, or queue settlement. Later
  deliberate Run/Resume actions remain allowed; allocation and terminal
  replacement/deletion assertions guard these boundaries. Also owns workflow
  terminal outcomes, queue stopping on uncertainty, recovering `hello`/vanished-run
  reconciliation, and reconnect health.
- `startupTerminalProjectSwitch.test.ts` — React-rendering coverage for startup
  terminal spawns across project switches. Drives the real
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
- `settingsSaveLifetime.test.ts` — rendered Settings controller and editable
  tabs with App-like launch state and the real shared settings/startup/metrics
  hooks. Deferred project and Pi-provider PATCHes pin that an accepted save
  keeps persisting its captured data without publishing callbacks, closing,
  or settling the busy/error state of a later project/dialog session. Includes
  A → B → A, close/reopen, unmount, no-project global saves, a concurrent save
  in B, and normal current-session success/error behavior.
