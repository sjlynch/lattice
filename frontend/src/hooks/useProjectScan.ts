import { useEffect, useState } from 'react';
import { scanFolder, subscribeHealth, type ScanResult } from '../api';
import { APP_CONFIG } from '../appConfig';

export function useProjectScan(activeFolder: string) {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);

    function tryScan() {
      if (cancelled) return;
      scanFolder(activeFolder)
        .then((r) => {
          if (cancelled) return;
          setScanResult(r);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          // Backend is probably still starting (boot race) or briefly
          // restarted. Retry with exponential backoff capped at 5s.
          // Loading stays true so the user keeps seeing the indicator
          // until we actually succeed.
          console.warn('scan failed (retrying)', err);
          const delay = Math.min(
            APP_CONFIG.scanRetry.maxDelayMs,
            APP_CONFIG.scanRetry.initialDelayMs
              * APP_CONFIG.scanRetry.backoffFactor ** attempt,
          );
          attempt += 1;
          timer = setTimeout(tryScan, delay);
        });
    }

    tryScan();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeFolder]);

  // Live health updates from chokidar on the backend. Each event
  // either patches a single file's metrics in place (on save) or
  // removes its node entirely (on delete). We patch the existing
  // scan result rather than re-scanning to keep simulation positions
  // stable.
  useEffect(() => {
    if (!activeFolder) return;
    return subscribeHealth(activeFolder, (event) => {
      setScanResult((prev) => {
        if (!prev) return prev;
        if (event.type === 'updated') {
          const idx = prev.nodes.findIndex(
            (n) => n.kind === 'file' && n.path === event.filePath,
          );
          if (idx === -1) return prev;
          const nextNodes = prev.nodes.slice();
          nextNodes[idx] = {
            ...nextNodes[idx],
            health: event.metrics.score,
            healthDetails: event.metrics,
            loc: event.metrics.loc,
          };
          return { ...prev, nodes: nextNodes };
        }
        // event.type === 'removed' — drop the node + any links to it.
        const filtered = prev.nodes.filter((n) => n.path !== event.filePath);
        if (filtered.length === prev.nodes.length) return prev;
        const nextLinks = prev.links.filter(
          (l) => l.source !== event.filePath && l.target !== event.filePath,
        );
        return { ...prev, nodes: filtered, links: nextLinks };
      });
    });
  }, [activeFolder]);

  return { scanResult, loading };
}
