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
  // How stale an auto-discovery sweep may be before a harness dropdown opening
  // triggers a fresh one (autoDiscover.ts). Short enough that restarting a local
  // server on a different model shows up almost immediately, long enough that
  // several dropdowns mounting at once don't each hit every endpoint.
  discoveryTtlMs: 15_000,
  // How long an HTTP handler may WAIT on an auto-discovery sweep before
  // answering from current state (the sweep still finishes in the background).
  // Comfortably above a healthy local server's few-millisecond `/v1/models`,
  // and well under probeTimeoutMs so one unreachable endpoint can't stall a
  // harness dropdown or a settings save for the full probe timeout.
  discoveryAwaitMs: 2500,
  // Above this many models, an endpoint stops surfacing its models wholesale in
  // the harness dropdowns and goes back to `piModelMenu` curation. OpenRouter
  // reports ~450; forcing every one into the dropdown makes it useless. A
  // machine you run models on serves one or two, so the zero-configuration path
  // stays zero-configuration.
  aggregatorModelCount: 5,
  // Separate, more generous cap on capability probing (thinking levels): one
  // request per model, once ever. Kept apart from the menu threshold on purpose
  // — an Ollama box with eight models wants curation but should still get its
  // thinking levels detected, and tying the two together would quietly cost it
  // `xhigh` for no benefit.
  thinkingProbeModelLimit: 25,
} as const;

// `~/.pi/agent` — where Pi keeps models.json (custom providers + friendly
// names) and settings.json (default model). Shared by discovery (read-only)
// and reconcile (reconcile.ts writes models.json here).
export function piAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}
