import type { PiModelInfo, PiProvider } from '../../api';

// Pure sanitization / derivation helpers for the Settings → Pi tab, split out of
// PiTab.tsx so the rendering components stay thin and these stay unit-testable.

// Drop blank/whitespace header keys and omit the map entirely when empty, so a
// half-typed header row never reaches models.json.
export function cleanHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.trim();
    if (key) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Rebuild a header record from ordered [key,value] pairs. fromEntries keeps
// insertion order (so editing a key in place doesn't reshuffle rows) and a
// transient empty/duplicate key just collapses — fine mid-edit.
export function entriesToHeaders(
  entries: [string, string][],
): Record<string, string> {
  return Object.fromEntries(entries);
}

// Read a string-valued compat key for an input value.
export function compatString(
  compat: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = compat?.[key];
  return typeof v === 'string' ? v : '';
}

// The providers to persist: drop incomplete rows (need an id + baseUrl) so a
// half-typed endpoint isn't written to models.json, trim ids/urls, drop blank
// model ids, and clean half-typed header rows.
export function sanitizeProvidersForSave(providers: PiProvider[]): PiProvider[] {
  return providers
    .map((p) => ({
      ...p,
      id: p.id.trim(),
      baseUrl: p.baseUrl.trim(),
      models: p.models.filter((m) => m.id.trim()),
      headers: cleanHeaders(p.headers),
    }))
    .filter((p) => p.id && p.baseUrl);
}

// The universe of selectable model patterns = saved models ∪ everything the
// draft endpoints declare (`<providerId>/<modelId>` for each complete pair).
export function collectModelUniverse(
  savedModels: PiModelInfo[],
  providers: PiProvider[],
): Set<string> {
  const universe = new Set<string>(savedModels.map((m) => m.pattern));
  for (const p of providers) {
    for (const m of p.models) {
      if (p.id && m.id) universe.add(`${p.id}/${m.id}`);
    }
  }
  return universe;
}
