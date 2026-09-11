import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  scanFolder,
  type HealthMetrics,
  type HealthUpdate,
  type ScanResult,
} from '../api';
import { patchUpdatedFiles, removeFile } from './scanResultPatch';
import { retryDelay, type RequestIdFence } from './scanRetry';
import {
  patchSnapshot,
  snapshotForScanResult,
  type ProjectScanSnapshot,
} from './scanSnapshot';

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

type HealthUpdateSchedulerArgs = {
  activeFolder: string;
  scanResultRef: MutableRefObject<ScanResult | null>;
  setSnapshot: Dispatch<SetStateAction<ProjectScanSnapshot>>;
  requestId: RequestIdFence;
};

export type HealthUpdateScheduler = {
  // Route one live health event (already gated on initial-scan-complete by the
  // caller) into the metric-batch queue or a debounced structural rescan.
  handleEvent: (event: HealthUpdate) => void;
  // Cancel in-flight work and clear every timer/queue on teardown.
  dispose: () => void;
};

// Owns the timer mechanics behind the live health-update stream: the path-keyed
// metric-batch queue (`METRIC_BATCH_MS`), the structural-rescan debounce
// (`STRUCTURAL_RESCAN_DEBOUNCE_MS`), the long removed-file rescan debounce
// (`REMOVED_RESCAN_DEBOUNCE_MS`), and the retrying backend rescan. Instantiated
// once per subscription so `useProjectScanScheduler`'s effect just subscribes
// and forwards events, reading as orchestration rather than timer plumbing.
export function createHealthUpdateScheduler({
  activeFolder,
  scanResultRef,
  setSnapshot,
  requestId,
}: HealthUpdateSchedulerArgs): HealthUpdateScheduler {
  let cancelled = false;
  let rescanAttempt = 0;
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  let scanController: AbortController | null = null;
  let rescanPending = false;
  let structuralVersion = 0;
  // Preserve live metrics received after a scan starts, even if their batch
  // already painted before the slower scan response arrives.
  const inFlightMetrics = new Map<string, HealthMetrics>();

  // Metric-only update queue (keyed by path so repeated saves of one file
  // collapse to the latest metrics) + its short coalescing timer.
  const metricQueue = new Map<string, HealthMetrics>();
  let metricTimer: ReturnType<typeof setTimeout> | null = null;

  const runRescan = () => {
    rescanTimer = null;
    if (cancelled) return;
    if (scanController) {
      rescanPending = true;
      return;
    }
    rescanPending = false;
    scanController = new AbortController();
    inFlightMetrics.clear();
    for (const [filePath, metrics] of metricQueue) inFlightMetrics.set(filePath, metrics);
    const version = structuralVersion;
    const id = requestId.next();
    scanFolder(activeFolder, scanController.signal)
      .then((result) => {
        // A removal/config change invalidates the result immediately, while
        // its replacement scan is still debouncing. Publishing it would
        // resurrect removed nodes and restart the graph twice unnecessarily.
        if (cancelled || !requestId.isCurrent(id) || version !== structuralVersion) return;
        rescanAttempt = 0;
        const patched = patchUpdatedFiles(result, Array.from(inFlightMetrics,
          ([filePath, metrics]) => ({ filePath, metrics })));
        scanResultRef.current = patched.result;
        setSnapshot(snapshotForScanResult(activeFolder, patched.result));
        if (patched.missing) requestRescan();
      })
      .catch((err) => {
        if (cancelled || !requestId.isCurrent(id) || version !== structuralVersion) return;
        console.warn('scan refresh failed (retrying)', err);
        const delay = retryDelay(rescanAttempt);
        rescanAttempt += 1;
        scheduleRescan(delay);
      })
      .finally(() => {
        scanController = null;
        inFlightMetrics.clear();
        // The debounce elapsed during a slow scan. Run just one follow-up;
        // bursts never launch concurrent full repository walks.
        if (!cancelled && rescanPending && !rescanTimer) scheduleRescan(0);
      });
  };

  function scheduleRescan(delay: number) {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(runRescan, delay);
  }

  const requestRescan = (delay: number = STRUCTURAL_RESCAN_DEBOUNCE_MS) => {
    structuralVersion += 1;
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

  const handleEvent = (event: HealthUpdate) => {
    if (cancelled) return;
    if (event.type === 'updated') {
      // Metric-only patch — coalesce into the batch queue.
      metricQueue.set(event.filePath, event.metrics);
      if (scanController) inFlightMetrics.set(event.filePath, event.metrics);
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
  };

  const dispose = () => {
    cancelled = true;
    scanController?.abort();
    if (rescanTimer) clearTimeout(rescanTimer);
    if (metricTimer) clearTimeout(metricTimer);
    metricQueue.clear();
    inFlightMetrics.clear();
  };

  return { handleEvent, dispose };
}
