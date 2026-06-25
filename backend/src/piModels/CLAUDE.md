# backend/src/piModels

Pi model config for the harness dropdowns. Public surface re-exports from
`../piModels.ts`. The load-bearing split is **read vs. write of Pi config**:

- `discovery.ts` — **READ-ONLY.** Parses `pi --list-models` (Pi prints the
  table to **stderr** — we parse combined output; memoized w/ short TTL +
  `resetPiModelsCache`), reads `~/.pi/agent/{models.json,settings.json}`
  read-only, and curates the "Pi — X" `menu`. `getPiModels(curated?)` →
  `{models, menu, defaultPattern}`; `resolvePiModel(project)` falls back to
  `UserSettings.piModel`. **Never writes Pi config.**
- `management.ts` — the **WRITE** side. `reconcilePiModelsJson()` upserts
  `globalSettings.piProviders` into `~/.pi/agent/models.json` (atomic
  temp+rename), preserving every hand-written provider and precisely deleting
  removed-managed ones via the `~/.lattice/piManagedProviders.json` sidecar.
  Every managed provider always gets an `apiKey` (defaults `"local"`) — one
  keyless provider makes Pi reject the *whole* file. `probeEndpointModels`
  backs the "Detect models" button. Reconcile invalidates discovery's cache.
- `config.ts` — tunables (`PI_MODELS_CONFIG`: list/probe timeouts, cache TTL)
  + `piAgentDir()` (`~/.pi/agent`), shared by both sides.

Model **SELECTION** is per-spawn via the `--model` flag
(`worktree/commands.ts` `buildPiModelFlag`); `settings.json` defaults are
never touched.
