import { useCallback, useState } from 'react';
import { useTerminals } from '../../../TerminalsContext';
import { type WorkflowRun } from '../../../api';
import {
  upsertRun,
  type ControlProgressMap,
  type RunMap,
} from './workflowRunSync';
import { useWorkflowRecentRuns } from './useWorkflowRecentRuns';
import { useWorkflowRunRecoveryFetch } from './useWorkflowRunRecoveryFetch';
import { useWorkflowRunSubscription } from './useWorkflowRunSubscription';

// Re-exported for the strip component and other consumers that imported it
// from here before the sync helpers were split out.
export type { ControlProgress } from './workflowRunSync';

// Tracks live workflow runs (`/ws/workflow-runs`) and hands per-step terminal
// spawns to the global TerminalsContext. Recently-finished runs linger in
// `recentRuns` for ~10s (completed) or 5min (errored/cancelled) so the UI can
// surface failures even after the user looks away from the screen.
//
// The pure state transitions live in `workflowRunSync.ts`, the recent-run
// linger lifecycle in `useWorkflowRecentRuns`, additive mount/visibility fetches
// in `useWorkflowRunRecoveryFetch`, and WS event routing / terminal spawning in
// `useWorkflowRunSubscription`. This hook is only the composition layer.
//
// Recovery design (see CLAUDE.md note on the disappearing-chip incident):
// the WS `hello` event from `/ws/workflow-runs` is the primary snapshot
// mechanism, and `subscribeWs` reconnects with exponential backoff so a
// dropped socket self-heals. We additionally fetch `/api/workflow-runs/active`
// on mount and on tab-visibility return as an *additive* safety net — it
// can rehydrate a run the WS missed but will never remove one. Removal is
// exclusively driven by `completed`/`errored`/`cancelled` WS events to
// avoid race conditions with the fetch (which can return a "still running"
// snapshot that pre-dates a recently received completion event).
export function useWorkflowRuns(activeFolder: string) {
  const [activeRuns, setActiveRuns] = useState<RunMap>({});
  const [controlProgress, setControlProgress] = useState<ControlProgressMap>(
    {},
  );
  const { addTerminal } = useTerminals();

  const { recentRuns, recentRunsRef, addRecentRun, dismissRecent } =
    useWorkflowRecentRuns(activeFolder);

  useWorkflowRunRecoveryFetch({
    activeFolder,
    recentRunsRef,
    setActiveRuns,
  });

  useWorkflowRunSubscription({
    activeFolder,
    addTerminal,
    setActiveRuns,
    setControlProgress,
    addRecentRun,
  });

  const addActiveRun = useCallback((run: WorkflowRun) => {
    setActiveRuns((cur) => upsertRun(cur, run));
  }, []);

  return { activeRuns, recentRuns, controlProgress, addActiveRun, dismissRecent };
}
