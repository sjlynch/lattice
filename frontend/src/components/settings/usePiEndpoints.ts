import { useState } from 'react';
import { probePiEndpoint, type PiProbeModel, type PiProvider } from '../../api';
import { dropEndpointKey, entriesToHeaders, nextEndpointId } from './piTabUtils';

// A blank provider row with a stable, non-colliding generated id. New endpoints
// auto-discover: pasting a base URL and saving is meant to be the whole job.
function blankProvider(id: string): PiProvider {
  return { id, baseUrl: '', autoDiscover: true, models: [] };
}

// Owns the draft endpoint list, its touched flag (the save clobber-guard), and
// the patch/add/remove mutators. `mutate` is the shared "apply an updater and
// mark touched" primitive the editor hook reuses for its compat / header /
// model / detect edits. `setProviders` / `setTouched` are exposed raw for the
// initial load, which must replace the list WITHOUT marking it touched.
export function useEndpointState() {
  const [providers, setProviders] = useState<PiProvider[]>([]);
  const [touched, setTouched] = useState(false);

  const mutate = (updater: (cur: PiProvider[]) => PiProvider[]) => {
    setTouched(true);
    setProviders(updater);
  };

  const patch = (idx: number, partial: Partial<PiProvider>) =>
    mutate((cur) => cur.map((p, i) => (i === idx ? { ...p, ...partial } : p)));

  // Derive the next id from the current list rather than a per-mount counter,
  // so adding a row after loading a saved `endpoint-1` can never re-mint it.
  const add = () => mutate((cur) => [...cur, blankProvider(nextEndpointId(cur))]);

  const remove = (idx: number) =>
    mutate((cur) => cur.filter((_, i) => i !== idx));

  return { providers, setProviders, touched, setTouched, mutate, patch, add, remove };
}

// Owns the per-endpoint "Detect models" transient state (probing / detected /
// probeError) and the probe flow itself. Keyed by the endpoint's STABLE id (not
// its array index) so removing an earlier endpoint never misattributes a
// survivor's detected list / error to it. `detect` reports the discovered ids
// back through `onDetected` so the caller can pre-select them on the provider;
// it never touches provider state directly. `dropEndpoint` forgets one id's
// entries when that endpoint is removed.
export function useProbeDetection() {
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [detected, setDetected] = useState<Record<string, PiProbeModel[]>>({});
  const [probeError, setProbeError] = useState<Record<string, string>>({});

  const reset = () => {
    setProbing({});
    setDetected({});
    setProbeError({});
  };

  // Seed each endpoint's visible model universe from what is already saved.
  // The checklist shows `detected ∪ selected`, so without this, un-ticking a
  // model in manual mode removes the only row that could put it back — the
  // endpoint's models came from auto-discovery, not from a probe click, so
  // `detected` is empty and the model simply vanishes until you press Detect.
  const seed = (providers: PiProvider[]) => {
    setDetected(
      Object.fromEntries(
        providers.map((p) => [
          p.id,
          p.models.map((m) =>
            m.contextWindow === undefined
              ? { id: m.id }
              : { id: m.id, contextWindow: m.contextWindow },
          ),
        ]),
      ),
    );
  };

  const dropEndpoint = (id: string) => {
    setProbing((p) => dropEndpointKey(p, id));
    setDetected((d) => dropEndpointKey(d, id));
    setProbeError((e) => dropEndpointKey(e, id));
  };

  const detect = async (
    id: string,
    ep: PiProvider | undefined,
    onDetected: (models: PiProbeModel[]) => void,
  ) => {
    if (!ep?.baseUrl.trim()) {
      setProbeError((e) => ({ ...e, [id]: 'Enter a base URL first.' }));
      return;
    }
    setProbing((p) => ({ ...p, [id]: true }));
    setProbeError((e) => ({ ...e, [id]: '' }));
    try {
      const models = await probePiEndpoint(
        ep.baseUrl.trim(),
        ep.apiKey?.trim() || undefined,
      );
      setDetected((d) => ({ ...d, [id]: models }));
      // A reachable endpoint that lists nothing is worth saying out loud —
      // otherwise the button just blinks and the checklist stays empty.
      if (models.length === 0) {
        setProbeError((e) => ({
          ...e,
          [id]: 'Endpoint reachable, but it lists no models.',
        }));
      }
      // Pre-select all detected models (the common case); the user can uncheck.
      onDetected(models);
    } catch (err) {
      setProbeError((e) => ({
        ...e,
        [id]: (err as Error).message || 'Probe failed',
      }));
    } finally {
      setProbing((p) => ({ ...p, [id]: false }));
    }
  };

  return { probing, detected, probeError, reset, seed, detect, dropEndpoint };
}

// The per-endpoint field editors — compat / headers / model checklist / detect —
// extracted from PiTab so the tab body stays draft-state + menu wiring + render.
// Every editor mutates the draft endpoint list through `endpoints.mutate` and is
// addressed by row index (provider mutations are index-based); the probe state
// `detect` touches is keyed by the endpoint's stable id. Returns the handler bag
// the PiEndpointCard rows need.
export function usePiEndpointEditors(
  endpoints: ReturnType<typeof useEndpointState>,
  probe: ReturnType<typeof useProbeDetection>,
  providers: PiProvider[],
) {
  // Set/clear a single `compat` key (empty/undefined removes it; the whole
  // compat object is dropped once it's empty so we don't write `compat: {}`).
  const updateCompat = (
    idx: number,
    key: string,
    value: string | boolean | undefined,
  ) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) => {
        if (i !== idx) return p;
        const compat: Record<string, unknown> = { ...(p.compat ?? {}) };
        if (value === undefined || value === '') delete compat[key];
        else compat[key] = value;
        const next = { ...p };
        if (Object.keys(compat).length) next.compat = compat;
        else delete next.compat;
        return next;
      }),
    );
  };

  const setHeaderEntries = (idx: number, entries: [string, string][]) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) =>
        i === idx ? { ...p, headers: entriesToHeaders(entries) } : p,
      ),
    );
  };

  // Read endpoint `idx`'s header rows as ordered entries, let `fn` mutate them
  // in place, then write the result back — the shared body of the four header
  // mutators below.
  const mutateHeaderEntries = (
    idx: number,
    fn: (entries: [string, string][]) => void,
  ) => {
    const entries = Object.entries(providers[idx]?.headers ?? {});
    fn(entries);
    setHeaderEntries(idx, entries);
  };

  const updateHeaderKey = (idx: number, rowIdx: number, key: string) =>
    mutateHeaderEntries(idx, (entries) => {
      if (entries[rowIdx]) entries[rowIdx] = [key, entries[rowIdx][1]];
    });

  const updateHeaderValue = (idx: number, rowIdx: number, value: string) =>
    mutateHeaderEntries(idx, (entries) => {
      if (entries[rowIdx]) entries[rowIdx] = [entries[rowIdx][0], value];
    });

  const addHeader = (idx: number) =>
    mutateHeaderEntries(idx, (entries) => {
      // Unique placeholder key so a second "add" never collides with a blank one.
      entries.push([`header-${entries.length + 1}`, '']);
    });

  const removeHeader = (idx: number, rowIdx: number) =>
    mutateHeaderEntries(idx, (entries) => {
      entries.splice(rowIdx, 1);
    });

  const toggleEndpointModel = (idx: number, modelId: string) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) => {
        if (i !== idx) return p;
        const has = p.models.some((m) => m.id === modelId);
        return {
          ...p,
          models: has
            ? p.models.filter((m) => m.id !== modelId)
            : [...p.models, { id: modelId }],
        };
      }),
    );
  };

  const detectModels = (idx: number) => {
    const ep = providers[idx];
    if (!ep) return;
    // Replace the model list with what the server actually offers, keeping any
    // per-model fields already saved for a model that survived. A context
    // window the server advertised WINS over a stored one: a re-detect is the
    // user asking what this endpoint serves now, and a stale window (from a
    // server restarted with a different `--max-model-len`) is exactly what
    // makes Pi mis-size its budget.
    return probe.detect(ep.id, ep, (probed) =>
      endpoints.mutate((cur) =>
        cur.map((p, i) =>
          i === idx
            ? {
                ...p,
                models: probed.map((pm) => ({
                  ...(p.models.find((m) => m.id === pm.id) ?? { id: pm.id }),
                  ...(pm.contextWindow === undefined
                    ? {}
                    : { contextWindow: pm.contextWindow }),
                })),
              }
            : p,
        ),
      ),
    );
  };

  return {
    updateCompat,
    updateHeaderKey,
    updateHeaderValue,
    addHeader,
    removeHeader,
    toggleEndpointModel,
    detectModels,
  };
}
