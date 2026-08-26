# backend/src/userSettings

Per-project user settings stored at `<project>/.lattice/userSettings.json`.
`../userSettings.ts` is a re-export barrel over this folder, so every consumer
keeps importing from `'../userSettings.js'` and the public surface is unchanged.

## Files

- `types.ts` — the `UserSettings` schema (with all per-field commentary) plus
  the `StartupTerminal` and `TerminalDefaultHarness` types. **No I/O.** Add new
  settings fields here.
- `storage.ts` — the path/storage layer: `settingsFile()`, `getUserSettings()`
  (read-or-`{}`), and `patchUserSettings()` (read-modify-write under the
  per-project `runExclusive('userSettings:<key>')` lock so concurrent disjoint
  patches don't clobber each other — see `serializeWrites.ts` and
  `__tests__/settingsPersistence.test.ts`). All paths are canonicalized via
  `canonicalProjectPath`. Also the **shape boundary** — see the invariant below.
- `features.ts` — feature-specific accessors layered on `getUserSettings`, each
  encoding a field's default semantics: `isClaudeMemoryDisabled`,
  `isPostMergeHookEnabled`, `isCodexYoloEnabled` (all default ON — an absent
  field counts as `true`) and `isQaTerminalAutoCloseEnabled` (default
  OFF/stay-open — only explicit `true` opts in). New "what does setting X mean
  for feature Y" helpers go here.
- `index.ts` — internal barrel re-exporting the public surface.

## Invariants

- **No taskCache import chain.** `storage.ts` imports `PROJECT_DIR_NAME` from
  `../taskCache/paths.js` (the leaf), **not** `../tasks.js` (which re-exports
  the whole task cache). userSettings is read at every Claude spawn by the MCP
  registry and the detached terminal-server, so it must stay free of that heavy
  chain. Keep new imports leaf-scoped.
- **A field the UI trusts field-by-field is coerced in `storage.ts`, on read
  AND on write.** These settings are not written only by the settings dialog:
  agents PATCH `/api/settings` directly, and the route hands the body through as
  `Partial<UserSettings>` — a TypeScript type that describes nothing at
  runtime. `startupTerminals` was stored verbatim as an agent-guessed
  `{name, command}` (no `id`, no `label`), and the dialog's `label.trim()` then
  threw on open, leaving that project's settings un-editable through the only UI
  that could have repaired the row (2026-08-26, interview_eci). So
  `normalizeUserSettings` runs in `getUserSettings` (a corrupt file heals on
  read) and on every incoming patch (a bad write never lands). It is a boundary
  guard, not a schema validator: add a field here only when a malformed value
  would break a consumer, and keep any minted identity **deterministic** — the
  frontend matches a live startup pty to its config by `id`, so an id that
  changed between reads would spawn a duplicate terminal on every reload. Pinned
  by `__tests__/startupTerminalsShape.test.ts`.
- **Default semantics live in the accessor, not the type.** A field being
  absent has a specific meaning per feature (memory-off-by-default,
  auto-close-off-by-default); encode that in `features.ts`, mirroring the
  opt-out/opt-in model documented on each field in `types.ts`.
