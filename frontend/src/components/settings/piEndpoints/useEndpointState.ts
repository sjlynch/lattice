import { useRef, useState } from 'react';
import type { PiProvider } from '../../../api';
import { nextEndpointId } from '../piTabUtils';

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
