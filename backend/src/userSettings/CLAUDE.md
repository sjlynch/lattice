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
  `canonicalProjectPath`.
- `features.ts` — feature-specific accessors layered on `getUserSettings`:
  `isClaudeMemoryDisabled` (default ON/memory-off — absent counts as `true`)
  and `isQaTerminalAutoCloseEnabled` (default OFF/stay-open — only explicit
  `true` opts in). New "what does setting X mean for feature Y" helpers go here.
- `index.ts` — internal barrel re-exporting the public surface.

## Invariants

- **No taskCache import chain.** `storage.ts` imports `PROJECT_DIR_NAME` from
  `../taskCache/paths.js` (the leaf), **not** `../tasks.js` (which re-exports
  the whole task cache). userSettings is read at every Claude spawn by the MCP
  registry and the detached terminal-server, so it must stay free of that heavy
  chain. Keep new imports leaf-scoped.
- **Default semantics live in the accessor, not the type.** A field being
  absent has a specific meaning per feature (memory-off-by-default,
  auto-close-off-by-default); encode that in `features.ts`, mirroring the
  opt-out/opt-in model documented on each field in `types.ts`.
