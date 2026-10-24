import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { fetchActiveWorkflowRuns, type WorkflowRun } from '../../../api';
import { isLatticeHidden, onLatticeVisibilityChange } from '../../floatingPanel/popoutRegistry';
import {
  mergeFetchedActiveRuns,
  VISIBILITY_REFETCH_MIN_INTERVAL_MS,
  type RunMap,
} from './workflowRunSync';

type RecoveryFetchArgs = {
  activeFolder: string;
  recentRunsRef: MutableRefObject<RunMap>;
  setActiveRuns: Dispatch<SetStateAction<RunMap>>;
};

function logFetchResult(
  origin: string,
  projectPath: string,
  fetchedCount: number,
  addedIds: string[],
) {
  if (addedIds.length > 0) {
    console.log(
      `[useWorkflowRuns] ${origin} added ${addedIds.length} run(s) ` +
        `not in WS state: ${addedIds.join(', ')} (project=${projectPath})`,
    );
  } else {
    console.log(
      `[useWorkflowRuns] ${origin} fetched ${fetchedCount} run(s); ` +
        `all already tracked (project=${projectPath})`,
    );
  }
}

// Additive recovery fetches for active workflow runs. The WS hello remains the
// authoritative snapshot/removal path; these fetches only rehydrate runs that a
// missed socket event failed to add, and never resurrect a finalized recent run.
export function useWorkflowRunRecoveryFetch({
  activeFolder,
  recentRunsRef,
  setActiveRuns,
}: RecoveryFetchArgs) {
  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;

    function applyFetched(fetched: WorkflowRun[], origin: string) {
      if (cancelled) return;
      setActiveRuns((cur) => {
        const { next, addedIds } = mergeFetchedActiveRuns(
          cur,
          recentRunsRef.current,
          fetched,
        );
        logFetchResult(origin, activeFolder, fetched.length, addedIds);
        return next;
      });
    }

    // Initial mount fetch. Runs in parallel with the WS subscribe — whichever
    // arrives first is reconciled safely by additive semantics / hello replace.
    fetchActiveWorkflowRuns(activeFolder)
      .then((fetched) => applyFetched(fetched, 'mount-fetch'))
      .catch((err) =>
        console.warn('[useWorkflowRuns] mount-fetch failed:', err),
      );

    // "Visible" = any Lattice window (a popped-out Workflows panel counts).
    let lastVisibilityFetchAt = 0;
    function onVisibility() {
      if (cancelled) return;
      if (isLatticeHidden()) return;
      const now = Date.now();
      if (now - lastVisibilityFetchAt < VISIBILITY_REFETCH_MIN_INTERVAL_MS) {
        return;
      }
      lastVisibilityFetchAt = now;
      fetchActiveWorkflowRuns(activeFolder)
        .then((fetched) => applyFetched(fetched, 'visibility-fetch'))
        .catch((err) =>
          console.warn('[useWorkflowRuns] visibility-fetch failed:', err),
        );
    }

    const stopVisibility = onLatticeVisibilityChange(onVisibility);
    return () => {
      cancelled = true;
      stopVisibility();
    };
  }, [activeFolder, recentRunsRef, setActiveRuns]);
}
