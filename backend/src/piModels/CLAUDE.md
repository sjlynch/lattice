# backend/src/piModels

Pi model config for the harness dropdowns. `../piModels.ts` is a re-export
barrel (`export *` from `discovery` + `management`); every consumer
(`routes/settings`, `routes/globalSettings`, `server/startup`, tasks, workflow
steps, tests) keeps importing from `'../piModels.js'`. The load-bearing split
is **read vs. write of Pi config**:

- `discovery.ts` — **READ-ONLY.** `getPiModels(curated?)` shells
  `pi --list-models` (Pi prints the table to **stderr** — we parse combined
  output; memoized w/ short TTL + `resetPiModelsCache()`), parses the
  fixed-width table (`parsePiListModels`, unit-tested), reads
  `~/.pi/agent/{models.json,settings.json}` read-only, and curates the
  "Pi — X" `menu` → `{models, menu, defaultPattern}`. Also
  `resolvePiModel(projectPath)` (falls back to `UserSettings.piModel`) and the
  `normalizePiModel` re-export (from `worktree/commands.ts`). **Never writes
  Pi config.**
- `management.ts` — the **WRITE** side. `reconcilePiModelsJson()` upserts
  `globalSettings.piProviders` into `~/.pi/agent/models.json` (atomic
  temp→rename), preserving every hand-written provider and precisely deleting
  removed-managed ones via the `~/.lattice/piManagedProviders.json` sidecar.
  Every managed provider always gets an `apiKey` (defaults `"local"`) — one
  keyless provider makes Pi reject the *whole* file. `probeEndpointModels`
  backs the "Detect models" button; reconcile invalidates discovery's cache.
- `config.ts` — tunables (`PI_MODELS_CONFIG`: list/probe timeouts, cache TTL)
  + `piAgentDir()` (`~/.pi/agent`), shared by both sides.

Model **SELECTION** is per-spawn via the `--model` flag
(`worktree/commands.ts` `buildPiModelFlag`); `settings.json` defaults are
never touched.

## Served by / tested by

`routes/settings/piModels.ts` (`GET /api/pi-models`) +
`routes/settings/piEndpoints.ts` (`POST /api/pi-endpoints/probe`).
`__tests__/piModels.test.ts` pins `parsePiListModels` + `sanitizePiProviders`
(via the `'../globalSettings.js'` / `'../piModels.js'` surfaces).
