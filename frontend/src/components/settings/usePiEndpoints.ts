import { useRef, useState } from 'react';
import { probePiEndpoint, type PiProvider } from '../../api';

// A blank provider row.
function blankProvider(seq: number): PiProvider {
  return { id: `endpoint-${seq}`, baseUrl: '', models: [] };
}

// Owns the draft endpoint list, its touched flag (the save clobber-guard), and
// the patch/add/remove mutators. `mutate` is the shared "apply an updater and
// mark touched" primitive the component reuses for its compat / header / model
// / detect edits. `setProviders` / `setTouched` are exposed raw for the initial
// load, which must replace the list WITHOUT marking it touched.
export function useEndpointState() {
  const [providers, setProviders] = useState<PiProvider[]>([]);
  const [touched, setTouched] = useState(false);
  const seqRef = useRef(0);

  const mutate = (updater: (cur: PiProvider[]) => PiProvider[]) => {
    setTouched(true);
    setProviders(updater);
  };

  const patch = (idx: number, partial: Partial<PiProvider>) =>
    mutate((cur) => cur.map((p, i) => (i === idx ? { ...p, ...partial } : p)));

  const add = () => mutate((cur) => [...cur, blankProvider(++seqRef.current)]);

  const remove = (idx: number) =>
    mutate((cur) => cur.filter((_, i) => i !== idx));

  return { providers, setProviders, touched, setTouched, mutate, patch, add, remove };
}

// Owns the per-endpoint "Detect models" transient state (probing / detected /
// probeError), keyed by row index, plus the probe flow itself. `detect` reports
// the discovered ids back through `onDetected` so the caller can pre-select
// them on the provider; it never touches provider state directly.
export function useProbeDetection() {
  const [probing, setProbing] = useState<Record<number, boolean>>({});
  const [detected, setDetected] = useState<Record<number, string[]>>({});
  const [probeError, setProbeError] = useState<Record<number, string>>({});

  const reset = () => {
    setProbing({});
    setDetected({});
    setProbeError({});
  };

  const detect = async (
    idx: number,
    ep: PiProvider | undefined,
    onDetected: (ids: string[]) => void,
  ) => {
    if (!ep?.baseUrl.trim()) {
      setProbeError((e) => ({ ...e, [idx]: 'Enter a base URL first.' }));
      return;
    }
    setProbing((p) => ({ ...p, [idx]: true }));
    setProbeError((e) => ({ ...e, [idx]: '' }));
    try {
      const ids = await probePiEndpoint(
        ep.baseUrl.trim(),
        ep.apiKey?.trim() || undefined,
      );
      setDetected((d) => ({ ...d, [idx]: ids }));
      // Pre-select all detected models (the common case); the user can uncheck.
      onDetected(ids);
    } catch (err) {
      setProbeError((e) => ({
        ...e,
        [idx]: (err as Error).message || 'Probe failed',
      }));
    } finally {
      setProbing((p) => ({ ...p, [idx]: false }));
    }
  };

  return { probing, detected, probeError, reset, detect };
}
