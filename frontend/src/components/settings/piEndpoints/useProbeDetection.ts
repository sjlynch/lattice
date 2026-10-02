import { useEffect, useRef, useState } from 'react';
import { probePiEndpoint, type PiProbeModel, type PiProvider } from '../../../api';
import { dropEndpointKey } from '../piTabUtils';

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
