# backend/src/piModels

Pi model discovery + endpoint management. `../piModels.ts` is a re-export barrel
(`export *` from `discovery` + `management`); every consumer
(`routes/settings`, `routes/globalSettings`, `server/startup`, tasks, workflow
steps, tests) keeps importing from `'../piModels.js'`. The full behavior is
documented in the root `backend/src/CLAUDE.md`; this is the file map.

## Split by read vs. write

- `discovery.ts` — the **read** side (never writes Pi config). `getPiModels(curated?)`
  shells `pi --list-models` (output is on **stderr**; memoized w/ short TTL +
  `resetPiModelsCache()`), parses the fixed-width table (`parsePiListModels`,
  unit-tested), reads `~/.pi/agent/models.json` + `settings.json` read-only, and
  returns `{models, menu, defaultPattern}`. Also `resolvePiModel(projectPath)`
  and the `normalizePiModel` re-export (from `worktree/commands.ts`).
- `management.ts` — the **write** side. `reconcilePiModelsJson()` upserts
  `globalSettings.piProviders` INTO `~/.pi/agent/models.json` (atomic temp→rename,
  preserves hand-written providers, tracks managed ids in the
  `~/.lattice/piManagedProviders.json` sidecar) and `probeEndpointModels(baseUrl,
  apiKey?)` GETs `<baseUrl>/models` for "Detect models". Invalidates
  `discovery`'s cache via `resetPiModelsCache` after a reconcile.
- `config.ts` — the one `PI_MODELS_CONFIG` object (the timeout/TTL knobs) +
  `piAgentDir()` (the shared `~/.pi/agent` path).

The `pi --list-models` spawn (`discovery.ts`) and `piSubagents.ts`'s `pi install`
spawn share `../spawnWithTimeout.ts`.

## Served by / tested by

`routes/settings/piModels.ts` (`GET /api/pi-models`) +
`routes/settings/piEndpoints.ts` (`POST /api/pi-endpoints/probe`).
`__tests__/piModels.test.ts` pins `parsePiListModels` + `sanitizePiProviders`
(via the `'../globalSettings.js'` / `'../piModels.js'` surfaces).
