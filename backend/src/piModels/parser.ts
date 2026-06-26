import type { ModelsCache, PiModelInfo } from './types.js';

// Parse the fixed-width `pi --list-models` table. Columns are separated by 2+
// spaces: `provider  model  context  max-out  thinking  images`. Exported via
// discovery.ts / piModels.ts for unit testing.
export function parsePiListModels(stdout: string): PiModelInfo[] {
  const out: PiModelInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s{2,}/);
    if (cols.length < 2) continue;
    const [provider, model] = cols;
    if (!provider || !model) continue;
    // Skip the header row.
    if (provider === 'provider' && model === 'model') continue;
    // Defensive: a provider/model token should never contain whitespace.
    if (/\s/.test(provider) || /\s/.test(model)) continue;
    out.push({
      provider,
      model,
      pattern: `${provider}/${model}`,
      contextWindow: cols[2] || undefined,
      thinking: cols[4] ? cols[4].toLowerCase() === 'yes' : undefined,
    });
  }
  return out;
}

// Decide what loadModels returns and caches given a fresh probe result and the
// existing cache. Extracted + exported so the transient-failure behaviour is
// unit-testable without spawning `pi`.
//
// `raw === null` means the probe FAILED transiently (timeout / spawn error). We
// must NOT overwrite (or even create) the cache with an empty list in that case
// — doing so would blank the menu and drop curated built-in models (which live
// only in `pi --list-models`, never in models.json) for the full TTL. Instead
// fall back to the last good cache if we have one (a stale list beats a blank
// menu), else return [] for just this call WITHOUT memoizing it so the next
// call re-probes immediately rather than waiting out the TTL.
export function reconcileModelsCache(
  raw: string | null,
  prev: ModelsCache | null,
  now: number,
): { models: PiModelInfo[]; cache: ModelsCache | null } {
  if (raw === null) {
    return { models: prev?.models ?? [], cache: prev };
  }
  const models = parsePiListModels(raw);
  return { models, cache: { at: now, models } };
}
