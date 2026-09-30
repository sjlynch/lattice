import { useEffect, useState } from 'react';
import { fetchOpengrepStatus, subscribeOpengrepStatus, type OpengrepStatus } from '../../../api/opengrep';

// Only engine status is read automatically. A Security scan remains a click.
export function useOpengrepAvailability(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearPoll = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const refresh = () => {
      clearPoll();
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      // Failed reads retain the last confirmed availability; initially hidden.
      void fetchOpengrepStatus(undefined, controller.signal).catch(() => {});
    };
    const accept = (status: OpengrepStatus) => {
      setAvailable(status.available);
      clearPoll();
      // Continue observing an accepted install even if Settings is closed.
      if (status.installJob?.status === 'running') timer = setTimeout(refresh, 1500);
    };
    const unsubscribe = subscribeOpengrepStatus(accept);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    refresh();
    return () => {
      unsubscribe();
      clearPoll();
      controller?.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return available;
}
