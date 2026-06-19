import { useEffect, useRef, useState } from 'react';
import { scanFolder, subscribeHealth, type HealthMetrics, type ScanResult } from '../api';
import { APP_CONFIG } from '../appConfig';
import { patchUpdatedFiles, removeFile } from './scanResultPatch';

const STRUCTURAL_RESCAN_DEBOUNCE_MS = 150;
// Coalesce a burst of metric-only `updated` events into a single
// `setScanResult`. The dev server writing files emits a HealthUpdate per save
// (tsc/vite emit + AV scan), and one React/App/Legend/ForceGraph render per
// file pins the main thread. Queue them for a short window and apply the whole
// burst at once; the queue is keyed by path so repeated saves of one file
// collapse to its latest metrics.
const METRIC_BATCH_MS = 50;
// Coalesce a burst of `removed` events into a single follow-up rescan.
// We already prune the file from the local ScanResult immediately for
// instant UI feedback, so the rescan only exists to drop now-empty
// parent dirs. A longer debounce here means renaming a folder or
// deleting a build directory doesn't fire 50 rescans → 50 force-engine
// reheats while the watcher drains. The fast-patch path in
// useGraphDataSync also short-circuits same-shape rescans, but the
// debounce lets us avoid even running the (synchronous, fs-walking)
// scan on the backend in the first place.
const REMOVED_RESCAN_DEBOUNCE_MS = 1500;

export function useProjectScan(activeFolder: string) {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  // `loading` reflects ONLY the initial scan for this project. Background
  // rescans triggered by watcher events refresh `scanResult` silently —
  // flipping `loading` back to true on every rescan trigger turned any
  // burst of chokidar events (common on Windows just after a watcher
  // starts up: AV scans, dev-server writes, …) into a permanent spinner
  // because the 150 ms rescan debounce kept resetting before `runRescan`
  // ever fired.
  const [loading, setLoading] = useState(false);
  const scanRequestIdRef = useRef(0);
  const scanResultRef = useRef<ScanResult | null>(null);
  // Health events that arrive before the initial scan completes are
  // dropped — the scan itself produces the authoritative state, so
  // re-running it because of a watcher event during boot would just
  // ping-pong forever on a slow Windows box. Once we have a scan, live
  // events take over.
  const initialScanCompleteRef = useRef(false);

  useEffect(() => {
    if (!activeFolder) {
      scanResultRef.current = null;
      initialScanCompleteRef.current = false;
      setScanResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    scanResultRef.current = null;
    initialScanCompleteRef.current = false;
    setLoading(true);

    function tryScan() {
      if (cancelled) return;
      const requestId = ++scanRequestIdRef.current;
      scanFolder(activeFolder)
        .then((r) => {
          if (cancelled || requestId !== scanRequestIdRef.current) return;
          scanResultRef.current = r;
          initialScanCompleteRef.current = true;
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
  // a debounced full scan so the visible graph tree matches disk — silently,
  // without touching `loading`.
  useEffect(() => {
    if (!activeFolder) return;

    let cancelled = false;
    let rescanAttempt = 0;
    let rescanTimer: ReturnType<typeof setTimeout> | null = null;

    // Metric-only update queue (keyed by path so repeated saves of one file
    // collapse to the latest metrics) + its short coalescing timer.
    const metricQueue = new Map<string, HealthMetrics>();
    let metricTimer: ReturnType<typeof setTimeout> | null = null;

    const flushMetricQueue = () => {
      if (metricTimer) {
        clearTimeout(metricTimer);
        metricTimer = null;
      }
      if (cancelled || metricQueue.size === 0) {
        metricQueue.clear();
        return;
      }
      const updates = Array.from(metricQueue, ([filePath, metrics]) => ({
        filePath,
        metrics,
      }));
      metricQueue.clear();
      const prev = scanResultRef.current;
      if (!prev) return;
      const { result, missing } = patchUpdatedFiles(prev, updates);
      if (result !== prev) {
        scanResultRef.current = result;
        setScanResult(result);
      }
      // A queued file wasn't in the scan yet (added after the last scan) — pull
      // it (and any new parent dirs) in with a structural rescan.
      if (missing) requestRescan();
    };

    const runRescan = () => {
      if (cancelled) return;
      const requestId = ++scanRequestIdRef.current;
      scanFolder(activeFolder)
        .then((r) => {
          if (cancelled || requestId !== scanRequestIdRef.current) return;
          rescanAttempt = 0;
          scanResultRef.current = r;
          setScanResult(r);
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
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(runRescan, delay);
    }

    const requestRescan = (delay: number = STRUCTURAL_RESCAN_DEBOUNCE_MS) => {
      rescanAttempt = 0;
      scheduleRescan(delay);
    };

    const unsubscribe = subscribeHealth(activeFolder, (event) => {
      // Until the initial scan lands, the authoritative state is "what
      // the scan returns" — drop watcher events instead of scheduling
      // competing rescans that just keep loading=true forever.
      if (!initialScanCompleteRef.current) return;

      if (event.type === 'updated') {
        // Metric-only patch — coalesce into the batch queue.
        metricQueue.set(event.filePath, event.metrics);
        if (!metricTimer) metricTimer = setTimeout(flushMetricQueue, METRIC_BATCH_MS);
        return;
      }

      // Structural events (rescan/removed) reorder the file tree, so apply any
      // queued metric patches first — they reference the pre-structural scan
      // and would otherwise be lost (or land on a stale tree).
      flushMetricQueue();

      if (event.type === 'rescan') {
        requestRescan();
        return;
      }

      const prev = scanResultRef.current;
      if (!prev) return;

      // event.type === 'removed' — drop the file immediately so the UI
      // updates without waiting for the rescan, then schedule a delayed
      // tree refresh to prune now-empty directory nodes. The long debounce
      // (REMOVED_RESCAN_DEBOUNCE_MS) collapses a burst of deletes (e.g.
      // `rm -rf` of a build dir) into a single backend scan instead of one
      // per file event.
      const next = removeFile(prev, event.filePath);
      if (next !== prev) {
        scanResultRef.current = next;
        setScanResult(next);
      }
      requestRescan(REMOVED_RESCAN_DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      if (rescanTimer) clearTimeout(rescanTimer);
      if (metricTimer) clearTimeout(metricTimer);
      metricQueue.clear();
      unsubscribe();
    };
  }, [activeFolder]);

  return { scanResult, loading };
}
