import { useEffect, useRef, useState } from 'react';
import { scanFolder, subscribeHealth, type ScanResult } from '../api';
import { APP_CONFIG } from '../appConfig';

const STRUCTURAL_RESCAN_DEBOUNCE_MS = 150;

type RuntimeLink = { source: unknown; target: unknown };

function linkEndpointId(endpoint: unknown): string | null {
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint && typeof endpoint === 'object') {
    const node = endpoint as { id?: unknown; path?: unknown };
    if (typeof node.id === 'string') return node.id;
    if (typeof node.path === 'string') return node.path;
  }
  return null;
}

function normalizeLinks(links: ScanResult['links']): ScanResult['links'] {
  const normalized: ScanResult['links'] = [];
  for (const link of links) {
    const runtimeLink = link as unknown as RuntimeLink;
    const source = linkEndpointId(runtimeLink.source);
    const target = linkEndpointId(runtimeLink.target);
    if (source && target) normalized.push({ source, target });
  }
  return normalized;
}

function patchUpdatedFile(
  prev: ScanResult,
  filePath: string,
  metrics: NonNullable<ScanResult['nodes'][number]['healthDetails']>,
): ScanResult | null {
  const idx = prev.nodes.findIndex(
    (n) => n.kind === 'file' && n.path === filePath,
  );
  if (idx === -1) return null;
  const nextNodes = prev.nodes.slice();
  nextNodes[idx] = {
    ...nextNodes[idx],
    health: metrics.score,
    healthDetails: metrics,
    loc: metrics.loc,
  };
  return { ...prev, nodes: nextNodes };
}

function removeFile(prev: ScanResult, filePath: string): ScanResult {
  const nextNodes = prev.nodes.filter((n) => n.path !== filePath);
  if (nextNodes.length === prev.nodes.length) return prev;
  const nextLinks = normalizeLinks(prev.links).filter(
    (l) => l.source !== filePath && l.target !== filePath,
  );
  return { ...prev, nodes: nextNodes, links: nextLinks };
}

export function useProjectScan(activeFolder: string) {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const scanRequestIdRef = useRef(0);
  const scanResultRef = useRef<ScanResult | null>(null);

  useEffect(() => {
    if (!activeFolder) {
      scanResultRef.current = null;
      setScanResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    scanResultRef.current = null;
    setLoading(true);

    function tryScan() {
      if (cancelled) return;
      const requestId = ++scanRequestIdRef.current;
      scanFolder(activeFolder)
        .then((r) => {
          if (cancelled || requestId !== scanRequestIdRef.current) return;
          scanResultRef.current = r;
          setScanResult(r);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled || requestId !== scanRequestIdRef.current) return;
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

  // Live health updates from chokidar on the backend. Regular file saves patch
  // metrics in place to keep the force simulation stable. Structural changes
  // (new source files, removed files/dirs, .gitignore/tsconfig changes) trigger
  // a debounced full scan so the visible graph tree matches disk.
  useEffect(() => {
    if (!activeFolder) return;

    let cancelled = false;
    let rescanAttempt = 0;
    let rescanTimer: ReturnType<typeof setTimeout> | null = null;

    const runRescan = () => {
      if (cancelled) return;
      const requestId = ++scanRequestIdRef.current;
      scanFolder(activeFolder)
        .then((r) => {
          if (cancelled || requestId !== scanRequestIdRef.current) return;
          rescanAttempt = 0;
          scanResultRef.current = r;
          setScanResult(r);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled || requestId !== scanRequestIdRef.current) return;
          console.warn('scan refresh failed (retrying)', err);
          const delay = Math.min(
            APP_CONFIG.scanRetry.maxDelayMs,
            APP_CONFIG.scanRetry.initialDelayMs
              * APP_CONFIG.scanRetry.backoffFactor ** rescanAttempt,
          );
          rescanAttempt += 1;
          scheduleRescan(delay);
        });
    };

    function scheduleRescan(delay: number) {
      setLoading(true);
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(runRescan, delay);
    }

    const requestRescan = () => {
      rescanAttempt = 0;
      scheduleRescan(STRUCTURAL_RESCAN_DEBOUNCE_MS);
    };

    const unsubscribe = subscribeHealth(activeFolder, (event) => {
      if (event.type === 'rescan') {
        requestRescan();
        return;
      }

      const prev = scanResultRef.current;
      if (!prev) {
        requestRescan();
        return;
      }

      if (event.type === 'updated') {
        const next = patchUpdatedFile(prev, event.filePath, event.metrics);
        if (!next) {
          // A source file was added after the last scan. Re-scan to add the
          // file node plus any new parent directory nodes/links.
          requestRescan();
          return;
        }
        scanResultRef.current = next;
        setScanResult(next);
        return;
      }

      // event.type === 'removed' — drop the file immediately, then refresh the
      // full tree to prune now-empty directory nodes and pick up any batched fs
      // changes that happened around the delete.
      const next = removeFile(prev, event.filePath);
      if (next !== prev) {
        scanResultRef.current = next;
        setScanResult(next);
      }
      requestRescan();
    });

    return () => {
      cancelled = true;
      if (rescanTimer) clearTimeout(rescanTimer);
      unsubscribe();
    };
  }, [activeFolder]);

  return { scanResult, loading };
}
