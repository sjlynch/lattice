// Pi endpoint PROBE for Lattice — the "Detect models" half of Pi endpoint
// management.
//
//   - probeEndpointModels(): GET <baseUrl>/models for the "Detect models" button.
//
// The models.json reconciliation half lives in ./reconcile.ts.

import { PI_MODELS_CONFIG } from './config.js';

// For a probe, use only a literal apiKey value as the bearer token. Pi itself
// can resolve env-var names / !commands when the saved provider is later used,
// but a user-supplied probe URL must never receive arbitrary ambient process
// secrets. A `!command` is also not executed during probes.
function resolveProbeKey(apiKey?: string): string | undefined {
  const key = apiKey?.trim();
  if (!key) return undefined;
  if (key.startsWith('!')) return undefined;
  return key;
}

// "Detect models" for the Settings → Pi endpoint form: GET <baseUrl>/models
// (OpenAI-compatible) and return the model ids. Throws on a non-OK response
// or network error so the route can surface it.
export async function probeEndpointModels(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_MODELS_CONFIG.probeTimeoutMs);
  try {
    const headers: Record<string, string> = {};
    const key = resolveProbeKey(apiKey);
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) throw new Error(`endpoint returned HTTP ${r.status}`);
    const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
    return (j?.data ?? [])
      .map((m) => m?.id)
      .filter((x): x is string => typeof x === 'string' && !!x);
  } finally {
    clearTimeout(timer);
  }
}
