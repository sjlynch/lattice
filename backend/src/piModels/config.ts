import os from 'node:os';
import path from 'node:path';

// One place for the discovery + management tunables that used to be bare
// literals scattered across the module (LIST_MODELS_TIMEOUT_MS,
// MODELS_CACHE_TTL_MS, PROBE_TIMEOUT_MS).
export const PI_MODELS_CONFIG = {
  // `pi --list-models` shells out to the CLI — bound the spawn.
  listModelsTimeoutMs: 8000,
  // Cache the parsed `pi --list-models` result briefly so repeated dropdown
  // opens don't each spawn a process. Config files (models.json / settings.json)
  // are cheap and read fresh on every call so a curation edit shows up at once.
  modelsCacheTtlMs: 30_000,
  // `<baseUrl>/models` probe timeout for the Settings → Pi "Detect models" button.
  probeTimeoutMs: 8000,
} as const;

// `~/.pi/agent` — where Pi keeps models.json (custom providers + friendly
// names) and settings.json (default model). Shared by discovery (read-only)
// and reconcile (reconcile.ts writes models.json here).
export function piAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}
