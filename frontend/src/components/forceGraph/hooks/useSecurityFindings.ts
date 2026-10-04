import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSecurityReviews } from '../../../api/opengrepReview';
import type { SecurityReview } from '../../../api/types/opengrep';

export function useSecurityFindings(project: string, onRefresh?: () => Promise<void>) {
  const [reviews, setReviews] = useState<SecurityReview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const claimed = useRef(new Set<symbol>());
  const lifetime = useRef(0);
  const running = reviews.some((r) => r.status === 'running' || r.status === 'awaiting-decision');
  const refreshRef = useRef(onRefresh); refreshRef.current = onRefresh;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const epoch = lifetime.current;
    const next = await fetchSecurityReviews(project, signal);
    if (alive.current && !signal?.aborted && epoch === lifetime.current) { setReviews(next); setLoadError(null); }
  }, [project]);
  useEffect(() => {
    lifetime.current++; claimed.current.clear(); setReviews([]); setBusy(false); setError(null); setNotice(null);
    return () => { lifetime.current++; };
  }, [project]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try { await refresh(controller.signal); }
      catch (err) { if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err)); }
      finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => void read(), running ? 3000 : 30_000);
    window.addEventListener('focus', read);
    return () => { alive.current = false; controller.abort(); clearInterval(timer); window.removeEventListener('focus', read); };
  }, [refresh, running]);
  const act = useCallback(async <T,>(operation: () => Promise<T>, message?: string, concurrent = false): Promise<T | undefined> => {
    if (claimed.current.size && !concurrent) return undefined;
    const claim = Symbol(); const epoch = lifetime.current;
    claimed.current.add(claim); setBusy(true); setError(null); setNotice(null);
    try {
      const value = await operation();
      if (!alive.current || epoch !== lifetime.current) return undefined;
      if (message) setNotice(message);
      await Promise.all([refresh(), refreshRef.current?.()]);
      return value;
    } catch (err) { if (alive.current && epoch === lifetime.current) setError(err instanceof Error ? err.message : String(err)); return undefined; }
    finally { claimed.current.delete(claim); if (alive.current && epoch === lifetime.current) setBusy(claimed.current.size > 0); }
  }, [refresh]);
  return { reviews, busy, error: error ?? loadError, notice, act };
}
