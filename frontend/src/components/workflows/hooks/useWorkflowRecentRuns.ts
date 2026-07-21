import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowRun } from '../../../api';
import { createRecentDismissalScheduler } from './recentDismissalScheduler';
import {
  addRecentRun as addRecentRunToMap,
  removeKey,
  type RunMap,
} from './workflowRunSync';

// Owns the project-scoped recent-run map and its linger timers. The caller only
// needs to add finalized runs; this hook clears stale project data on folder
// changes, keeps a ref for additive fetch reconciliation, and cancels pending
// dismissal timers when the project subscription is torn down.
export function useWorkflowRecentRuns(activeFolder: string) {
  const [recentRuns, setRecentRuns] = useState<RunMap>({});

  const recentRunsRef = useRef(recentRuns);
  recentRunsRef.current = recentRuns;

  const schedulerRef = useRef<ReturnType<
    typeof createRecentDismissalScheduler
  > | null>(null);

  useEffect(() => {
    // Recent runs are project-scoped. Active runs are replaced by the new
    // project's WS hello, but recent runs have no server snapshot to overwrite
    // them, so clear them immediately on any project change.
    recentRunsRef.current = {};
    setRecentRuns({});

    schedulerRef.current?.cancelAll();
    schedulerRef.current = null;
    if (!activeFolder) return;

    let active = true;
    const dismissals = createRecentDismissalScheduler((id) => {
      if (!active) return;
      const next = removeKey(recentRunsRef.current, id);
      recentRunsRef.current = next;
      setRecentRuns(next);
    });
    schedulerRef.current = dismissals;

    return () => {
      active = false;
      dismissals.cancelAll();
      if (schedulerRef.current === dismissals) schedulerRef.current = null;
    };
  }, [activeFolder]);

  const addRecentRun = useCallback((run: WorkflowRun) => {
    // Update the ref synchronously, before React schedules a render. A fast
    // workflow's completion WS and /run response can land in the same turn;
    // the response path must be able to see the completed run immediately.
    const next = addRecentRunToMap(recentRunsRef.current, run);
    recentRunsRef.current = next;
    setRecentRuns(next);
    schedulerRef.current?.schedule(run.id, run.status);
  }, []);

  const dismissRecent = useCallback((id: string) => {
    const next = removeKey(recentRunsRef.current, id);
    recentRunsRef.current = next;
    setRecentRuns(next);
  }, []);

  return { recentRuns, recentRunsRef, addRecentRun, dismissRecent };
}
