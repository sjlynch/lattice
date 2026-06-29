import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { scanFolder, subscribeHealth, type HealthMetrics, type ScanResult } from '../api';
import { APP_CONFIG } from '../appConfig';
import { patchUpdatedFiles, removeFile } from './scanResultPatch';

export type ProjectScanSnapshot = {
  root: string;
  result: ScanResult | null;
  loading: boolean;
};

const EMPTY_SCAN_SNAPSHOT: ProjectScanSnapshot = {
  root: '',
  result: null,
  loading: false,
};

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

type SchedulerArgs = {
  activeFolder: string;
  scanResultRef: MutableRefObject<ScanResult | null>;
  setSnapshot: Dispatch<SetStateAction<ProjectScanSnapshot>>;
};

function snapshotForInitialScan(root: string): ProjectScanSnapshot {
  return { root, result: null, loading: true };
}

function snapshotForScanResult(root: string, result: ScanResult): ProjectScanSnapshot {
  return { root, result, loading: false };
}

function patchSnapshot(
  root: string,
  setSnapshot: Dispatch<SetStateAction<ProjectScanSnapshot>>,
  patch: (prev: ScanResult) => ScanResult,
) {
  setSnapshot((prev) => {
    if (prev.root !== root || !prev.result) return prev;
    const next = patch(prev.result);
    return next === prev.result ? prev : { ...prev, result: next };
  });
}

// Owns all scan side effects: initial retrying scan, live HealthUpdate
// subscription, metric batching, and debounced structural rescans. The public
// useProjectScan hook keeps the state shape/derivation, while this helper owns
// only timers, subscriptions, and request cancellation.
export function useProjectScanScheduler({
  activeFolder,
  scanResultRef,
  setSnapshot,
}: SchedulerArgs) {
  const scanRequestIdRef = useRefCounter();
  // Health events that arrive before the initial scan completes are dropped —
  // the scan itself produces the authoritative state, so re-running it because
  // of a watcher event during boot would just ping-pong forever on a slow
  // Windows box. Once we have a scan, live events take over.
  const initialScanCompleteRef = useInitialScanCompleteFlag(activeFolder);

  useEffect(() => {
    if (!activeFolder) {
      scanResultRef.current = null;
      initialScanCompleteRef.current = false;
      setSnapshot(EMPTY_SCAN_SNAPSHOT);
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    scanResultRef.current = null;
    initialScanCompleteRef.current = false;
    setSnapshot(snapshotForInitialScan(activeFolder));

    function tryScan() {
      if (cancelled) return;
      const requestId = scanRequestIdRef.next();
      scanFolder(activeFolder)
        .then((result) => {
          if (cancelled || !scanRequestIdRef.isCurrent(requestId)) return;
          scanResultRef.current = result;
          initialScanCompleteRef.current = true;
          setSnapshot(snapshotForScanResult(activeFolder, result));
        })
        .catch((err) => {
          if (cancelled || !scanRequestIdRef.isCurrent(requestId)) return;
          // Backend is probably still starting (boot race) or briefly
          // restarted. Retry with exponential backoff capped by APP_CONFIG.
          // Loading stays true so the user keeps seeing the indicator until we
          // actually succeed.
          console.warn('scan failed (retrying)', err);
          const delay = retryDelay(attempt);
          attempt += 1;
          timer = setTimeout(tryScan, delay);
        });
    }

    tryScan();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeFolder, initialScanCompleteRef, scanRequestIdRef, scanResultRef, setSnapshot]);

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

    const runRescan = () => {
      if (cancelled) return;
      const requestId = scanRequestIdRef.next();
      scanFolder(activeFolder)
        .then((result) => {
          if (cancelled || !scanRequestIdRef.isCurrent(requestId)) return;
          rescanAttempt = 0;
          scanResultRef.current = result;
          setSnapshot(snapshotForScanResult(activeFolder, result));
        })
        .catch((err) => {
          if (cancelled || !scanRequestIdRef.isCurrent(requestId)) return;
          console.warn('scan refresh failed (retrying)', err);
          const delay = retryDelay(rescanAttempt);
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
        patchSnapshot(activeFolder, setSnapshot, () => result);
      }
      // A queued file wasn't in the scan yet (added after the last scan) — pull
      // it (and any new parent dirs) in with a structural rescan.
      if (missing) requestRescan();
    };

    const unsubscribe = subscribeHealth(activeFolder, (event) => {
      // Until the initial scan lands, the authoritative state is "what the scan
      // returns" — drop watcher events instead of scheduling competing rescans
      // that just keep loading=true forever.
      if (!initialScanCompleteRef.current) return;

      if (event.type === 'updated') {
        // Metric-only patch — coalesce into the batch queue.
        metricQueue.set(event.filePath, event.metrics);
        if (!metricTimer) metricTimer = setTimeout(flushMetricQueue, METRIC_BATCH_MS);
        return;
      }

      // Structural events (rescan/removed) reorder the file tree, so apply any
      // queued metric patches first — they reference the pre-structural scan and
      // would otherwise be lost (or land on a stale tree).
      flushMetricQueue();

      if (event.type === 'rescan') {
        requestRescan();
        return;
      }

      const prev = scanResultRef.current;
      if (!prev) return;

      // event.type === 'removed' — drop the file immediately so the UI updates
      // without waiting for the rescan, then schedule a delayed tree refresh to
      // prune now-empty directory nodes. The long debounce collapses a burst of
      // deletes (e.g. `rm -rf` of a build dir) into one backend scan.
      const next = removeFile(prev, event.filePath);
      if (next !== prev) {
        scanResultRef.current = next;
        patchSnapshot(activeFolder, setSnapshot, () => next);
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
  }, [activeFolder, initialScanCompleteRef, scanRequestIdRef, scanResultRef, setSnapshot]);
}

function retryDelay(attempt: number): number {
  return Math.min(
    APP_CONFIG.scanRetry.maxDelayMs,
    APP_CONFIG.scanRetry.initialDelayMs
      * APP_CONFIG.scanRetry.backoffFactor ** attempt,
  );
}

function useRefCounter() {
  const requestIdRef = useRef(0);
  const apiRef = useRef({
    next: () => {
      requestIdRef.current += 1;
      return requestIdRef.current;
    },
    isCurrent: (requestId: number) => requestId === requestIdRef.current,
  });
  return apiRef.current;
}

function useInitialScanCompleteFlag(activeFolder: string) {
  const ref = useRef(false);
  const folderRef = useRef(activeFolder);
  // Reset synchronously for consumers that read it before passive effect cleanup
  // on a project switch.
  if (folderRef.current !== activeFolder) {
    folderRef.current = activeFolder;
    ref.current = false;
  }
  if (!activeFolder) ref.current = false;
  return ref;
}
