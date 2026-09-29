import { useEffect, useRef, useState } from 'react';
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
// model / detect edits. `setProviders` / `setTouched` are exposed for the
// initial load, which must replace the list WITHOUT marking it touched.
export function useEndpointState(onRequestInvalidated?: (id: string) => void) {
  const [providers, publishProviders] = useState<PiProvider[]>([]);
  // Update request identity synchronously with edits, before React renders.
  // A -> B -> A in one batch must still invalidate the request started at A.
  const current = useRef<PiProvider[]>([]);
  const requests = useRef(new WeakMap<PiProvider, { token: object; fingerprint: string }>());
  const fingerprint = (p: PiProvider) =>
    JSON.stringify([p.id, p.baseUrl, p.apiKey, p.headers, p.api]);
  const [touched, setTouched] = useState(false);
  // True once this open's global-settings GET succeeded. The save patch is the
  // WHOLE provider list (the backend deletes every managed provider missing
  // from it), so until the saved list is actually in the draft nothing may be
  // written — see `piProvidersPatch`.
  const [loaded, setLoaded] = useState(false);

  const setProviders = (value: PiProvider[] | ((cur: PiProvider[]) => PiProvider[])) => {
    const next = typeof value === 'function' ? value(current.current) : value;
    // A load/replacement creates fresh row instances, even if ids are reused.
    for (const p of current.current) onRequestInvalidated?.(p.id);
    for (const p of next) requests.current.set(p, { token: {}, fingerprint: fingerprint(p) });
    current.current = next;
    publishProviders(next);
  };

  const mutate = (updater: (cur: PiProvider[]) => PiProvider[]) => {
    const cur = current.current;
    const next = updater(cur);
    if (next === cur) return;
    // Editors clone a row in place; removal/reordering retains the survivor's
    // object. Keep its token across metadata edits and index shifts, but mint
    // one for every request edit and newly added row.
    const live = new Set<object>();
    next.forEach((p, idx) => {
      const previous = requests.current.get(p) ?? (cur[idx] && requests.current.get(cur[idx]));
      const config = fingerprint(p);
      const request = previous?.fingerprint === config ? previous : { token: {}, fingerprint: config };
      requests.current.set(p, request);
      live.add(request.token);
    });
    for (const p of cur) {
      const request = requests.current.get(p);
      if (request && !live.has(request.token)) onRequestInvalidated?.(p.id);
    }
    current.current = next;
    setTouched(true);
    publishProviders(next);
  };

  const requestToken = (p: PiProvider) => requests.current.get(p)?.token;
  const isCurrentRequest = (token: object | undefined) =>
    token !== undefined && current.current.some((p) => requestToken(p) === token);

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
    requestToken,
    isCurrentRequest,
    getProvider: (idx: number) => current.current[idx],
  };
}

// Owns the per-endpoint "Detect models" transient state (probing / detected /
// probeError) and the probe flow itself. Keyed by the endpoint's STABLE id (not
// its array index) so removing an earlier endpoint never misattributes a
// survivor's detected list / error to it. `detect` reports the discovered ids
// back through `onDetected` so the caller can pre-select them on the provider;
// it never touches provider state directly. `dropEndpoint` forgets one id's
// entries and invalidates pending work when that row's request changes or it
// is removed. Each detect also gets a token so overlapping requests cannot
// publish a result/error or clear a newer request's busy flag.
//
// `generation` fences probes to the Settings session that started them: `reset`
// (run on every dialog open) and unmount bump it, and a probe that resolves
// under an older generation touches nothing — no `setDetected`, no
// `onDetected`. Without it a slow Detect from a cancelled session landed after
// reopen, replaced that endpoint's curated models and marked the draft touched,
// so the next unrelated Save wrote the clobbered list.
export function useProbeDetection() {
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [detected, setDetected] = useState<Record<string, PiProbeModel[]>>({});
  const [probeError, setProbeError] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const requests = useRef(new Map<string, object>());

  useEffect(
    () => () => {
      generation.current += 1;
      requests.current.clear();
    },
    [],
  );

  const reset = () => {
    generation.current += 1;
    requests.current.clear();
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
    // Deleting the request token fences removal/id reuse and request edits.
    requests.current.delete(id);
    setProbing((p) => dropEndpointKey(p, id));
    setDetected((d) => dropEndpointKey(d, id));
    setProbeError((e) => dropEndpointKey(e, id));
  };

  const detect = async (
    id: string,
    ep: PiProvider | undefined,
    onDetected: (models: PiProbeModel[]) => void,
    isCurrentRequest: () => boolean = () => true,
  ) => {
    const gen = generation.current;
    const request = {};
    requests.current.set(id, request);
    const stale = () =>
      gen !== generation.current || requests.current.get(id) !== request || !isCurrentRequest();
    if (!ep?.baseUrl.trim()) {
      setProbing((p) => stale() ? p : { ...p, [id]: false });
      setProbeError((e) => stale() ? e : { ...e, [id]: 'Enter a base URL first.' });
      return;
    }
    setProbing((p) => stale() ? p : { ...p, [id]: true });
    setProbeError((e) => stale() ? e : { ...e, [id]: '' });
    try {
      const models = await probePiEndpoint(
        ep.baseUrl.trim(),
        ep.apiKey?.trim() || undefined,
        ep.headers === undefined ? undefined : { ...ep.headers },
      );
      if (stale()) return;
      setDetected((d) => stale() ? d : { ...d, [id]: models });
      // A reachable endpoint that lists nothing is worth saying out loud —
      // otherwise the button just blinks and the checklist stays empty.
      if (models.length === 0) {
        setProbeError((e) => stale() ? e : {
          ...e,
          [id]: 'Endpoint reachable, but it lists no models.',
        });
      }
      // Pre-select all detected models (the common case); the user can uncheck.
      onDetected(models);
    } catch (err) {
      if (stale()) return;
      setProbeError((e) => stale() ? e : {
        ...e,
        [id]: (err as Error).message || 'Probe failed',
      });
    } finally {
      // `reset` already cleared `probing`; a stale probe must not write into
      // the new session's map.
      if (!stale()) setProbing((p) => stale() ? p : { ...p, [id]: false });
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
  _providers: PiProvider[],
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
    const ep = endpoints.getProvider(idx);
    if (!ep) return;
    const token = endpoints.requestToken(ep);
    const isCurrent = () => endpoints.isCurrentRequest(token);
    // Replace the model list with what the server actually offers. Addressed
    // by the endpoint's id when the probe resolves, never by `idx` — see
    // applyDetectedModels.
    return probe.detect(
      ep.id,
      ep,
      (probed) => endpoints.mutate((cur) => isCurrent()
          ? applyDetectedModels(cur, ep.id, probed, (p) => endpoints.requestToken(p) === token)
          : cur),
      isCurrent,
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
