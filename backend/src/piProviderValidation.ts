// Defensive shape validation for Lattice-managed Pi providers — the
// `piProviders` field of globalSettings.json (OpenAI-compatible endpoints such
// as a local vLLM server, reconciled INTO ~/.pi/agent/models.json by
// piModels.ts's reconcilePiModelsJson).
//
// The provider list arrives as untrusted JSON off the /api/global-settings
// PATCH, so only well-formed entries survive: a non-empty `id` + `baseUrl`, and
// each model at least an `id`. The PiProvider/PiProviderModel types are
// declared in the node-free piModels/types.ts (the frontend shares them) and
// re-exported here and from globalSettings.ts for back-compat. Split out of
// globalSettings.ts (the read/write facade); exercised directly by
// __tests__/piModels.test.ts.

import { sanitizeThinkingLevels } from './piModels/thinkingLevels.js';
import type { PiProvider, PiProviderModel } from './piModels/types.js';

export type { PiProvider, PiProviderModel } from './piModels/types.js';

// Defensive shape validation for Lattice-managed Pi providers. Keeps only
// well-formed entries (a non-empty id + baseUrl and at least the model id) and
// rejects duplicate ids (keeping the first). Exported for unit testing.
const UNSAFE_PROVIDER_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizePiProviders(raw: unknown): PiProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: PiProvider[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id.trim()) continue;
    // The id becomes a key of models.json's `providers` map and the
    // `provider/` half of a `provider/model` pattern. `__proto__` as a key
    // re-points the map's prototype instead of adding an entry (the provider
    // silently never reaches Pi), and a `/` splits the pattern in the wrong
    // place.
    if (UNSAFE_PROVIDER_IDS.has(e.id.trim()) || e.id.includes('/')) continue;
    if (typeof e.baseUrl !== 'string' || !e.baseUrl.trim()) continue;
    // models.json is keyed by provider id, so a second provider sharing an id
    // would silently overwrite the first on reconcile while globalSettings
    // still showed both rows. Drop the later duplicate.
    if (seen.has(e.id.trim())) continue;
    const models: PiProviderModel[] = [];
    if (Array.isArray(e.models)) {
      for (const m of e.models) {
        if (!m || typeof m !== 'object') continue;
        const mm = m as Record<string, unknown>;
        if (typeof mm.id !== 'string' || !mm.id.trim()) continue;
        const model: PiProviderModel = { id: mm.id.trim() };
        if (typeof mm.name === 'string' && mm.name) model.name = mm.name;
        if (typeof mm.reasoning === 'boolean') model.reasoning = mm.reasoning;
        if (typeof mm.contextWindow === 'number' && mm.contextWindow > 0) {
          model.contextWindow = Math.floor(mm.contextWindow);
        }
        if (typeof mm.maxTokens === 'number' && mm.maxTokens > 0) {
          model.maxTokens = Math.floor(mm.maxTokens);
        }
        const levels = sanitizeThinkingLevels(mm.thinkingLevels);
        if (levels) model.thinkingLevels = levels;
        models.push(model);
      }
    }
    const provider: PiProvider = {
      id: e.id.trim(),
      baseUrl: e.baseUrl.trim(),
      models,
    };
    if (typeof e.autoDiscover === 'boolean') provider.autoDiscover = e.autoDiscover;
    if (typeof e.api === 'string' && e.api) provider.api = e.api;
    if (typeof e.apiKey === 'string' && e.apiKey) provider.apiKey = e.apiKey;
    // Do not drop empty maps: they carry an explicit clear from Settings,
    // distinct from absent fields when adopting a hand-written provider.
    if (e.headers && typeof e.headers === 'object') {
      provider.headers = stringRecord(e.headers);
    }
    if (e.compat && typeof e.compat === 'object') {
      provider.compat = e.compat as Record<string, unknown>;
    }
    seen.add(provider.id);
    out.push(provider);
  }
  return out;
}

// Keep only the string-valued keys of an object (the headers map).
function stringRecord(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// Auto-discovery is ON unless the endpoint explicitly opts out, so an endpoint
// saved before this existed (and one added by someone who never opened
// Advanced) starts working on its own. Lives here rather than in
// piModels/autoDiscover.ts so the read-only discovery path can ask the question
// without importing the write path. See piModels/autoDiscover.ts.
export function isAutoDiscoverEnabled(provider: PiProvider): boolean {
  return provider.autoDiscover !== false;
}
