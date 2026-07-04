# backend/src/piModels

Pi model config for the harness dropdowns. `../piModels.ts` is a re-export
barrel (`export *` from `discovery` + `reconcile` + `probe`); every consumer
(`routes/settings`, `routes/globalSettings`, `server/startup`, tasks, workflow
steps, tests) keeps importing from `'../piModels.js'`. The load-bearing split
is **read vs. write of Pi config**.

## Read-only discovery map

- `discovery.ts` — stable public facade for the read-only side. Exposes
  `getPiModels(curated?)`, `resolvePiModel(projectPath)`, the historical
  `parsePiListModels` / `reconcileModelsCache` exports, `resetPiModelsCache`,
  types, and the `normalizePiModel` re-export. **Never writes Pi config.**
- `parser.ts` — parses the fixed-width `pi --list-models` table
  (`parsePiListModels`) and owns `reconcileModelsCache`, including the
  transient-failure rule: `null` means timeout/spawn error, so keep the last
  good cache (or return uncached `[]` cold); `''` is a successful empty listing
  and is cached.
- `listModels.ts` — executes `pi --list-models` with timeout, parses combined
  stdout+stderr because Pi prints the table to **stderr**, memoizes successful
  parsed results for `PI_MODELS_CONFIG.modelsCacheTtlMs`, and provides
  `resetPiModelsCache()` for management-side invalidation.
- `files.ts` — read-only readers for `~/.pi/agent/models.json` (custom
  provider friendly names / default-menu provider set) and `settings.json`
  (Pi's current `defaultProvider/defaultModel`).
- `menu.ts` — curates the "Pi — X" `menu`: curated `globalSettings.piModelMenu`
  wins when non-empty; otherwise default to every model from a
  models.json-declared provider plus Pi's current default. Entries remain valid
  if reported by `pi --list-models` **or** declared in `models.json`, so a
  fragile CLI probe doesn't hide explicitly configured models.
- `types.ts` — shared `PiModelInfo`, `PiMenuEntry`, `PiModelsResult`,
  `ModelsJson`, and cache shapes.

## Write-side management

- `reconcile.ts` — `reconcilePiModelsJson()` upserts
  `globalSettings.piProviders` into `~/.pi/agent/models.json` (atomic
  temp→rename), preserving every hand-written provider and precisely deleting
  removed-managed ones via the `~/.lattice/piManagedProviders.json` sidecar.
  Every managed provider always gets an `apiKey` (defaults `"local"`) — one
  keyless provider makes Pi reject the *whole* file. Reconcile invalidates
  discovery's cache.
- `probe.ts` — `probeEndpointModels()` GETs `<baseUrl>/models` (OpenAI-compatible)
  behind the "Detect models" button; only a literal `apiKey` becomes the bearer
  token (never ambient env / `!command` secrets).
- `config.ts` — tunables (`PI_MODELS_CONFIG`: list/probe timeouts, cache TTL)
  + `piAgentDir()` (`~/.pi/agent`), shared by both sides.

Model **SELECTION** is per-spawn via the `--model` flag
(`worktree/commands.ts` `buildPiModelFlag`); `settings.json` defaults are
never touched.

## Served by / tested by

`routes/settings/piModels.ts` (`GET /api/pi-models`) +
`routes/settings/piEndpoints.ts` (`POST /api/pi-endpoints/probe`).
`__tests__/piModels.test.ts` pins `parsePiListModels`, `reconcileModelsCache`,
and `sanitizePiProviders` (via the `'../globalSettings.js'` /
`'../piModels.js'` surfaces).
