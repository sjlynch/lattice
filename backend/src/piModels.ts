// Pi models — re-export barrel.
//
// The implementation is split by concern under ./piModels/:
//   - discovery.ts  — stable read-only facade for parser/listModels/files/menu
//                     (parsePiListModels, getPiModels, resolvePiModel,
//                      resetPiModelsCache, normalizePiModel re-export, types).
//   - parser.ts     — `pi --list-models` parsing + cache reconciliation rules.
//   - listModels.ts — `pi --list-models` execution + TTL cache.
//   - files.ts      — read-only models.json/settings.json readers.
//   - menu.ts       — default/curated harness menu construction.
//   - management.ts — write side: reconcilePiModelsJson + probeEndpointModels.
//   - config.ts     — shared timeout/TTL config object + the ~/.pi/agent path.
//
// This barrel keeps the historical `./piModels.js` import path working for
// every consumer (routes/settings, routes/globalSettings, server/startup,
// tasks, workflow steps, the test) — the public surface is unchanged.

export * from './piModels/discovery.js';
export * from './piModels/management.js';
