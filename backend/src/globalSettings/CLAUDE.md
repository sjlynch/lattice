# Global settings

Machine-global settings, stored at `~/.lattice/globalSettings.json` — distinct
from per-project `userSettings.ts`. "Global" = facts about the *machine*, not a
project: one backend, one terminal-server, one machine's RAM/CPU, one shared Pi
config (`~/.pi/agent/`).

The code is a `../globalSettings.ts` read/write **facade** plus per-field
validators living next to the shape each produces. There is no
`globalSettings/` source code — this directory holds only these docs.

## What "global" covers

| Field | Meaning | Validated in |
|-------|---------|--------------|
| `maxConcurrentAgents` | The spawn queue's **softCap** — agents over it are deferred in the queue, never dropped (`spawnQueue.ts`). | `clampMaxConcurrentAgents` in `../globalSettings.ts` (bounds `[MIN_MAX_CONCURRENT_AGENTS=1, MAX_MAX_CONCURRENT_AGENTS=150]`; env-seeded default `LATTICE_MAX_CONCURRENT_AGENTS` else `DEFAULT_MAX_CONCURRENT_AGENTS=24`). The 150 upper bound stays well under the terminal-server hard cap (200) so the reserve band + manual terminals keep headroom. |
| `mcpCustomServers` | User-added MCP server **definitions** (built-in catalog stays in code; secret values live in `~/.lattice/mcpSecrets.json`, never here). | `sanitizeCustomServers` in `../mcp/settingsValidation.ts`. |
| `mcpBuiltinOverrides` | Per-id partial edits of built-in catalog entries (e.g. edited args). | `sanitizeBuiltinOverrides` in `../mcp/settingsValidation.ts`. |
| `piModelMenu` | Curated `provider/model` patterns surfaced as "Pi — X" rows in the harness dropdowns; empty/absent → the default menu (see `piModels.ts`). | Inline string-array filter in `../globalSettings.ts`'s `sanitize`. |
| `piProviders` | Lattice-managed Pi providers (OpenAI-compatible endpoints, e.g. vLLM), reconciled INTO `~/.pi/agent/models.json` by `piModels.ts`. | `sanitizePiProviders` in `../piProviderValidation.ts` (which also owns the `PiProvider`/`PiProviderModel` types). |

## Shape

- `../globalSettings.ts` — `GlobalSettings` type, the concurrency bounds +
  clamp, and `getGlobalSettings` / `updateGlobalSettings` (read with
  defaults-fallback; merge-update + persist). `sanitize()` validates a
  raw/partial object field-by-field, delegating each field to its focused
  validator. Only *present* fields are touched, so a partial PATCH (e.g. just
  the agent cap) never wipes the MCP / Pi fields.
- `../mcp/settingsValidation.ts` — the two MCP defensive parsers (next to the
  `McpServerEntry` shape they validate).
- `../piProviderValidation.ts` — the Pi-provider parser + its types (next to
  its `piModels.ts` consumer / `reconcilePiModelsJson` reconciler).

The MCP/Pi validators and the `PiProvider`/`PiProviderModel` types are
re-exported from `../globalSettings.ts` so the historical
`import { … } from './globalSettings.js'` surface (`piModels.ts` + the unit
tests) keeps working.

## Served by

`routes/globalSettings.ts` — `GET`/`PATCH /api/global-settings`. A `PATCH`:
1. forwards each field through `updateGlobalSettings` (which sanitizes each);
2. applies the new `maxConcurrentAgents` to the live spawn queue via
   `setSpawnQueueSoftCap` (so a cap change takes effect without a restart —
   raising it drains deferred spawns into the new headroom);
3. when `piProviders` changed, calls `reconcilePiModelsJson()` so the new
   endpoint's models are immediately discoverable.

## Tests

- `__tests__/mcp.settingsValidation.test.ts` → `sanitizeCustomServers`, `sanitizeBuiltinOverrides`.
- `__tests__/piModels.test.ts` → `sanitizePiProviders`.

Both still import from `../globalSettings.js` (the re-export surface), so the
split is invisible to them.
