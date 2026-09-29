import type { PiProvider } from '../../../api';
import { cleanHeaders } from './headers';

// A draft can drop its final compat key while still remembering that the user
// explicitly cleared it. The enumerable symbol follows the existing object
// spreads used by endpoint edits/probes without adding a public provider field.
// Save converts it to an empty map, then strips the draft-only marker.
const CLEARED_COMPAT = Symbol('clearedCompat');
type ProviderDraft = PiProvider & { [CLEARED_COMPAT]?: true };

// Set/clear a single `compat` key on a provider (empty/undefined removes it;
// the whole compat object is dropped once it's empty in the editing draft).
export function setCompatKey(
  provider: PiProvider,
  key: string,
  value: string | boolean | undefined,
): PiProvider {
  const compat: Record<string, unknown> = { ...(provider.compat ?? {}) };
  if (value === undefined || value === '') delete compat[key];
  else compat[key] = value;
  const next: ProviderDraft = { ...provider };
  if (Object.keys(compat).length) {
    next.compat = compat;
    delete next[CLEARED_COMPAT];
  } else {
    delete next.compat;
    next[CLEARED_COMPAT] = true;
  }
  return next;
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
    .map((p) => {
      const { [CLEARED_COMPAT]: clearCompat, ...provider } = p as ProviderDraft;
      return {
        ...provider,
        id: p.id.trim(),
        baseUrl: p.baseUrl.trim(),
        models: p.models.filter((m) => m.id.trim()),
        // Absence preserves advanced config when adopting a hand-written
        // provider. An explicit empty map means clear, even after JSON/validation.
        headers: cleanHeaders(p.headers) ?? (p.headers ? {} : undefined),
        ...(clearCompat ? { compat: {} } : {}),
      };
    })
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

// The Pi-providers save patch. `undefined` (= leave the saved list alone)
// unless the saved list actually LOADED and the user edited it. The patch is
// the whole list and the backend reconcile deletes every Lattice-managed
// provider missing from it, so a draft seeded from a FAILED load (empty) plus
// one "Add endpoint" used to delete every endpoint the user had configured.
export function piProvidersPatch(
  providers: PiProvider[],
  state: { loaded: boolean; touched: boolean },
): PiProvider[] | undefined {
  if (!state.loaded || !state.touched) return undefined;
  return sanitizeProvidersForSave(providers);
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
