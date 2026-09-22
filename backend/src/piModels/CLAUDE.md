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
  discovery's cache, skips the write entirely when the file already matches, and
  is **serialized** (`runExclusive`) using the shared `atomicWriteFile` — it now
  runs on every discovery sweep, so two calls can overlap, and Pi re-reads
  models.json every time `/model` opens (a plain rename over a file another
  process holds throws EPERM on Windows). It reads `globalSettings` STRICTLY:
  an unreadable/corrupt `globalSettings.json` aborts the reconcile rather than
  reading as "no providers" and deleting every managed one.
- `probe.ts` — `probeEndpointModels()` GETs `<baseUrl>/models` (OpenAI-compatible)
  behind the "Detect models" button, returning `{id, contextWindow?}` per model;
  only a literal `apiKey` becomes the bearer token (never ambient env /
  `!command` secrets). The context window is read from whichever key the server
  uses (`max_model_len` on vLLM/NInfer/SGLang, `context_length` on
  llama.cpp/LM Studio, …) and carried onto the saved provider model, so
  models.json gets the endpoint's real window instead of Pi's conservative
  default — the difference between a 262K-context local server being usable and
  being quietly capped.
- `autoDiscover.ts` — `refreshEndpointDiscovery()` keeps each `autoDiscover`
  endpoint's model list matching what it actually serves: probe → merge into
  `globalSettings.piProviders` → reconcile. Called at boot, after a settings
  save, and from `GET /api/pi-models` (every harness dropdown open). A failed or
  empty probe KEEPS the stored models — blanking them is what leaves Pi with no
  model to run — and reconcile runs on every sweep, so a models.json that
  drifted out of sync is repaired even when the probe changed nothing. The
  provider list is **re-read inside the global-settings write lock**
  (`updateGlobalSettingsWith` — every probe, thinking levels included, finishes
  first) and each result is applied only where it still belongs (same id, still
  auto, same `baseUrl`), so a Settings save landing mid-probe — or queued on the
  lock ahead of the sweep's write — isn't silently undone. Pinned by `__tests__/autoDiscover.test.ts`.
- `thinkingLevels.ts` — Pi gives a model `xhigh` / `max` ONLY if it declares a
  `thinkingLevelMap`; with the map absent Pi **silently clamps** them to `high`
  (verified: asking for `max` sends `reasoning_effort: "high"`, no error). The
  levels are detected, never hardcoded: `probeThinkingLevels` posts one request
  with a deliberately invalid `reasoning_effort`, and a server that validates the
  field rejects it with a message enumerating the valid ones — the whole answer,
  for zero generated tokens. `parseAcceptedEffortTokens` needs ≥2 recognizable
  tokens before it trusts a message, so prose can't produce a map that hides
  levels which actually work. `probeThinkingLevels` is tri-state: tokens, `[]`
  (a 2xx — the server validates nothing, recorded so the model isn't re-asked),
  or `null` for NO answer (network error / timeout, a non-400/422 status such
  as a 5xx or a 401 from a `$VAR` key, an unparseable rejection) — on `null`
  the model is left untouched and asked again next sweep, never marked
  "ordinary". Detection runs once per newly-seen model (`[]` records "asked,
  nothing extended" — `sanitizeThinkingLevels` must keep an empty array, or the
  marker is lost on the settings round-trip and every sweep re-probes) and
  never against an aggregator. Both probes run on the
  provider snapshot BEFORE the re-read, so a save landing mid-probe survives.
- `sweepScheduler.ts` — the scheduling policy behind it, isolated so it is
  testable without a server: join an in-flight sweep (even inside the TTL, or
  the caller reads state that sweep is about to replace), throttle by TTL only
  when idle, `force` never adopts a sweep that started before the change that
  forced it (and two concurrent forcers still run ONE sweep at a time), and
  `maxWaitMs` bounds the WAIT without bounding the work (an HTTP
  handler must not sit behind a probe timing out against a dead host).
  Pinned by `__tests__/sweepScheduler.test.ts`.
- `config.ts` — tunables (`PI_MODELS_CONFIG`: list/probe timeouts, cache TTL)
  + `piAgentDir()` (`~/.pi/agent`), shared by both sides.

Model **SELECTION** is per-spawn via the `--model` flag
(`worktree/commands.ts` `buildPiModelFlag`); `settings.json` defaults are
never touched.

## Served by / tested by

`routes/settings/piModels.ts` (`GET /api/pi-models`) +
`routes/settings/piEndpoints.ts` (`POST /api/pi-endpoints/probe`).
`__tests__/piModels.test.ts` pins `parsePiListModels`, `reconcileModelsCache`,
`sanitizePiProviders` (via the `'../globalSettings.js'` / `'../piModels.js'`
surfaces), `parseProbedModels` (the `/models` context-window spellings), and
`buildMenu`'s collision handling.
