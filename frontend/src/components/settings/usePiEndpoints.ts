import { useState } from 'react';
import { probePiEndpoint, type PiProbeModel, type PiProvider } from '../../api';
import {
  addHeaderEntry,
  applyDetectedModels,
  dropEndpointKey,
  nextEndpointId,
  removeHeaderEntry,
  setCompatKey,
  setHeaderKey,
  setHeaderValue,
} from './piTabUtils';

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
  // True once this open's global-settings GET succeeded. The save patch is the
  // WHOLE provider list (the backend deletes every managed provider missing
  // from it), so until the saved list is actually in the draft nothing may be
  // written — see `piProvidersPatch`.
  const [loaded, setLoaded] = useState(false);

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

  return {
    providers,
    setProviders,
    touched,
    setTouched,
    loaded,
    setLoaded,
    mutate,
    patch,
    add,
    remove,
  };
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
  // Set/clear a single `compat` key — see setCompatKey.
  const updateCompat = (
    idx: number,
    key: string,
    value: string | boolean | undefined,
  ) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) => (i === idx ? setCompatKey(p, key, value) : p)),
    );
  };

  // Apply a pure header-record updater to endpoint `idx` — the shared body of
  // the four header mutators below. Reads the CURRENT draft inside the updater
  // rather than the render-time `providers`, so back-to-back edits compose.
  const mutateHeaders = (
    idx: number,
    fn: (headers: Record<string, string> | undefined) => Record<string, string>,
  ) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) => (i === idx ? { ...p, headers: fn(p.headers) } : p)),
    );
  };

  const updateHeaderKey = (idx: number, rowIdx: number, key: string) =>
    mutateHeaders(idx, (h) => setHeaderKey(h, rowIdx, key));

  const updateHeaderValue = (idx: number, rowIdx: number, value: string) =>
    mutateHeaders(idx, (h) => setHeaderValue(h, rowIdx, value));

  const addHeader = (idx: number) => mutateHeaders(idx, addHeaderEntry);

  const removeHeader = (idx: number, rowIdx: number) =>
    mutateHeaders(idx, (h) => removeHeaderEntry(h, rowIdx));

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
    // Replace the model list with what the server actually offers. Addressed
    // by the endpoint's id when the probe resolves, never by `idx` — see
    // applyDetectedModels.
    return probe.detect(ep.id, ep, (probed) =>
      endpoints.mutate((cur) => applyDetectedModels(cur, ep.id, probed)),
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
