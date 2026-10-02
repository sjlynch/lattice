import type { PiProvider } from '../../../api';
import {
  addHeaderEntry,
  applyDetectedModels,
  removeHeaderEntry,
  setCompatKey,
  setHeaderKey,
  setHeaderValue,
} from '../piTabUtils';
import type { useEndpointState } from './useEndpointState';
import type { useProbeDetection } from './useProbeDetection';

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
