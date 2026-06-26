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
// model ids, clean half-typed header rows, and reject duplicate ids.
export function sanitizeProvidersForSave(providers: PiProvider[]): PiProvider[] {
  const seen = new Set<string>();
  return providers
    .map((p) => ({
      ...p,
      id: p.id.trim(),
      baseUrl: p.baseUrl.trim(),
      models: p.models.filter((m) => m.id.trim()),
      headers: cleanHeaders(p.headers),
    }))
    .filter((p) => p.id && p.baseUrl)
    // Drop duplicate managed ids, keeping the first: models.json is keyed by
    // provider id, so a second row sharing an id would silently clobber the
    // first on reconcile while globalSettings still showed both. The Add-
    // endpoint id generator avoids auto-dupes; this guards a hand-typed one.
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
}

// The next free auto-generated endpoint id. Scans the current providers for the
// `endpoint-<N>` pattern and returns `endpoint-<max+1>` — guaranteed not to
// collide with an existing `endpoint-N`. Fixes the Add-endpoint duplicate-id
// bug: a per-mount seqRef that always started at 0 re-minted `endpoint-1` over
// a previously-saved `endpoint-1`, which reconcile then silently overwrote.
export function nextEndpointId(providers: PiProvider[]): string {
  let max = 0;
  for (const p of providers) {
    const m = /^endpoint-(\d+)$/.exec(p.id.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `endpoint-${max + 1}`;
}

// Drop one endpoint id's entry from an id-keyed transient-state record (the
// per-endpoint probe maps / advancedOpen). Returns the SAME reference when the
// id is absent so a React setState can bail out of a re-render. Keying these by
// the endpoint's stable id (not its array index) is what keeps each survivor's
// detected-models / Advanced / error state attached to the right endpoint after
// an earlier endpoint in the list is removed.
export function dropEndpointKey<T>(
  map: Record<string, T>,
  id: string,
): Record<string, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
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
