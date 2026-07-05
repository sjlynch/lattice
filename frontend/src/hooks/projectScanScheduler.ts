import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { scanFolder, subscribeHealth, type ScanResult } from '../api';
import { createHealthUpdateScheduler } from './healthUpdateScheduler';
import { retryDelay, useRequestIdFence } from './scanRetry';
import {
  EMPTY_SCAN_SNAPSHOT,
  snapshotForInitialScan,
  snapshotForScanResult,
  type ProjectScanSnapshot,
} from './scanSnapshot';

export type { ProjectScanSnapshot } from './scanSnapshot';

type SchedulerArgs = {
  activeFolder: string;
  scanResultRef: MutableRefObject<ScanResult | null>;
  setSnapshot: Dispatch<SetStateAction<ProjectScanSnapshot>>;
};

// Owns all scan side effects: initial retrying scan, live HealthUpdate
// subscription, metric batching, and debounced structural rescans. The public
// useProjectScan hook keeps the state shape/derivation, while this helper wires
// the two effects together — request fencing (`scanRetry`), snapshot shaping
// (`scanSnapshot`), and the live-update timer mechanics (`healthUpdateScheduler`)
// each live in their own module so the effects below read as orchestration.
export function useProjectScanScheduler({
  activeFolder,
  scanResultRef,
  setSnapshot,
}: SchedulerArgs) {
  const requestId = useRequestIdFence();
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
      const id = requestId.next();
      scanFolder(activeFolder)
        .then((result) => {
          if (cancelled || !requestId.isCurrent(id)) return;
          scanResultRef.current = result;
          initialScanCompleteRef.current = true;
          setSnapshot(snapshotForScanResult(activeFolder, result));
        })
        .catch((err) => {
          if (cancelled || !requestId.isCurrent(id)) return;
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
  }, [activeFolder, initialScanCompleteRef, requestId, scanResultRef, setSnapshot]);

  // Live health updates from chokidar on the backend. Regular file saves patch
  // metrics in place to keep the force simulation stable. Structural changes
  // (new source files, removed files/dirs, .gitignore/tsconfig changes) trigger
  // a debounced full scan so the visible graph tree matches disk — silently,
  // without touching `loading`. All of that timer/queue mechanics lives in the
  // scheduler; this effect just subscribes, gates on the initial scan, and
  // forwards events.
  useEffect(() => {
    if (!activeFolder) return;

    const scheduler = createHealthUpdateScheduler({
      activeFolder,
      scanResultRef,
      setSnapshot,
      requestId,
    });

    const unsubscribe = subscribeHealth(activeFolder, (event) => {
      // Until the initial scan lands, the authoritative state is "what the scan
      // returns" — drop watcher events instead of scheduling competing rescans
      // that just keep loading=true forever.
      if (!initialScanCompleteRef.current) return;
      scheduler.handleEvent(event);
    });

    return () => {
      scheduler.dispose();
      unsubscribe();
    };
  }, [activeFolder, initialScanCompleteRef, requestId, scanResultRef, setSnapshot]);
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
