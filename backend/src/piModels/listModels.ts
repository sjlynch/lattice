import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { PI_MODELS_CONFIG } from './config.js';
import { reconcileModelsCache } from './parser.js';
import type { ModelsCache, PiModelInfo } from './types.js';

let modelsCache: ModelsCache | null = null;

// Run `pi --list-models`, returning the combined output on a SUCCESSFUL spawn
// (even if empty) or `null` on a TRANSIENT failure (timeout / spawn error).
// The null-vs-string distinction is load-bearing: loadModels must not cache a
// transient failure as a successful empty listing (see reconcileModelsCache).
async function runListModels(): Promise<string | null> {
  const r = await spawnWithTimeout('pi', ['--list-models'], {
    // shell:true so Windows resolves `pi` → `pi.cmd`; args are static.
    shell: process.platform === 'win32',
    timeoutMs: PI_MODELS_CONFIG.listModelsTimeoutMs,
  });
  // Pi prints the table to STDERR, not stdout — parse the combined output so
  // we're robust to that (and to any future change). A timeout or spawn error
  // is a transient failure, signalled as null so we don't memoize it.
  if (r.timedOut || r.error) return null;
  return r.combined;
}

// Single-flight: several harness dropdowns mount at once, and with a cold (or
// expired) cache each used to spawn its own `pi --list-models` — up to the 8s
// timeout apiece. Concurrent callers now share one spawn. `generation` fences a
// run that a resetPiModelsCache() overtook: its result predates the models.json
// write that triggered the reset, so it is returned to its own callers but
// never cached, and never clears the newer run's slot.
let inFlight: Promise<PiModelInfo[]> | null = null;
let generation = 0;

export async function loadModels(): Promise<PiModelInfo[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < PI_MODELS_CONFIG.modelsCacheTtlMs) {
    return modelsCache.models;
  }
  if (inFlight) return inFlight;
  const gen = generation;
  const run = (async () => {
    const raw = await runListModels();
    const { models, cache } = reconcileModelsCache(raw, modelsCache, now);
    if (gen === generation) modelsCache = cache;
    return models;
  })().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

// Force a re-probe of `pi --list-models` — call after reconciling models.json
// (reconcile.ts) so a newly-added provider shows up without waiting out the TTL.
export function resetPiModelsCache(): void {
  modelsCache = null;
  inFlight = null;
  generation += 1;
}
