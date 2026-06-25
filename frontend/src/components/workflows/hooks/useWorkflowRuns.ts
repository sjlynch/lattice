import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminals } from '../../../TerminalsContext';
import {
  fetchActiveWorkflowRuns,
  subscribeWorkflowRuns,
  type WorkflowRun,
} from '../../../api';
import { createRecentDismissalScheduler } from './recentDismissalScheduler';
import {
  activeRunsFromHello,
  addRecentRun,
  clearStaleControlProgress,
  mergeFetchedActiveRuns,
  removeKey,
  setControlProgress as applyControlProgress,
  upsertRun,
  VISIBILITY_REFETCH_MIN_INTERVAL_MS,
  type ControlProgressMap,
  type RunMap,
} from './workflowRunSync';
import {
  stepSpawnedTerminal,
  workflowTaskSpawnedTerminal,
} from './workflowTerminalSpawns';

// Re-exported for the strip component and other consumers that imported it
// from here before the sync helpers were split out.
export type { ControlProgress } from './workflowRunSync';

// Tracks live workflow runs (`/ws/workflow-runs`) and hands per-step terminal
// spawns to the global TerminalsContext. Recently-finished runs linger in
// `recentRuns` for ~10s (completed) or 5min (errored/cancelled) so the UI can
// surface failures even after the user looks away from the screen.
//
// The pure state transitions live in `workflowRunSync.ts`, the linger timers
// in `recentDismissalScheduler.ts`, and the terminal-spawn mapping in
// `workflowTerminalSpawns.ts`; this hook is the wiring that subscribes, fetches
// additively, and routes each WS event through those helpers.
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
  const [recentRuns, setRecentRuns] = useState<RunMap>({});
  const [controlProgress, setControlProgress] = useState<ControlProgressMap>(
    {},
  );
  const { addTerminal } = useTerminals();

  // Mirrored so the additive fetch reconciler can read the freshest known
  // recent-runs map without re-running on every state change.
  const recentRunsRef = useRef(recentRuns);
  recentRunsRef.current = recentRuns;

  const dismissRecent = useCallback((id: string) => {
    setRecentRuns((cur) => removeKey(cur, id));
  }, []);

  useEffect(() => {
    // Recent runs are project-scoped. The effect re-runs on every folder
    // change (deps below), so wipe the previous project's recent runs here —
    // unlike `activeRuns` (replaced wholesale by the new project's `hello`),
    // nothing else clears them, and the cleanup below cancels the old
    // project's pending dismiss timers. Without this, project A's
    // finished/failed runs would linger forever in project B's UI.
    setRecentRuns({});
    if (!activeFolder) {
      setActiveRuns({});
      setControlProgress({});
      return;
    }
    let cancelled = false;

    // Deferred removal of recent runs, with a status-dependent delay so
    // errored/cancelled runs stay visible long enough for the user to notice.
    // `cancelAll` in cleanup wipes pending timers on activeFolder change.
    const dismissals = createRecentDismissalScheduler((id) => {
      if (cancelled) return;
      setRecentRuns((cur) => removeKey(cur, id));
    });

    // Additive reconciler: merge `fetched` into `activeRuns` without removing
    // anything. A run in `recentRuns` was finalized by a WS event we already
    // saw — don't resurrect it from a stale fetch.
    function applyFetched(fetched: WorkflowRun[], origin: string) {
      if (cancelled) return;
      setActiveRuns((cur) => {
        const { next, addedIds } = mergeFetchedActiveRuns(
          cur,
          recentRunsRef.current,
          fetched,
        );
        if (addedIds.length > 0) {
          console.log(
            `[useWorkflowRuns] ${origin} added ${addedIds.length} run(s) ` +
              `not in WS state: ${addedIds.join(', ')} (project=${activeFolder})`,
          );
        } else {
          console.log(
            `[useWorkflowRuns] ${origin} fetched ${fetched.length} run(s); ` +
              `all already tracked (project=${activeFolder})`,
          );
        }
        return next;
      });
    }

    // Initial mount fetch. Runs in parallel with the WS subscribe below — if
    // the WS `hello` arrives first the fetch is a no-op (its runs are all
    // already in activeRuns). If the fetch arrives first, the subsequent
    // `hello` overwrites with the authoritative snapshot which by definition
    // contains every run the fetch saw.
    fetchActiveWorkflowRuns(activeFolder)
      .then((fetched) => applyFetched(fetched, 'mount-fetch'))
      .catch((err) =>
        console.warn('[useWorkflowRuns] mount-fetch failed:', err),
      );

    // Re-fetch on visibility-return as a safety net: if the WS dropped while
    // the tab was hidden and a backend-side completion event was therefore
    // lost (it shouldn't be — the reconnect's `hello` should replace state —
    // but defensively), this restores any active run that wasn't already in
    // local state. Throttled so a quickly-flipping focus doesn't hammer the
    // backend.
    let lastVisibilityFetchAt = 0;
    function onVisibility() {
      if (cancelled) return;
      if (document.visibilityState !== 'visible') return;
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
    document.addEventListener('visibilitychange', onVisibility);

    const unsub = subscribeWorkflowRuns(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type === 'hello') {
        // Authoritative server snapshot — replace activeRuns entirely. The
        // `hello` is emitted both on initial connect and on every WS
        // reconnect (see backend/src/ws/projectEndpoint.ts), so this also
        // serves as the recovery path after a network/socket drop.
        console.log(
          `[useWorkflowRuns] hello: ${ev.runs.length} active run(s) ` +
            `(project=${activeFolder})`,
        );
        setActiveRuns(activeRunsFromHello(ev.runs));
      } else if (ev.type === 'started' || ev.type === 'progress') {
        setActiveRuns((cur) => upsertRun(cur, ev.run));
        setControlProgress((cur) =>
          clearStaleControlProgress(cur, ev.run.id, ev.run.currentStepIndex),
        );
      } else if (
        ev.type === 'completed' ||
        ev.type === 'errored' ||
        ev.type === 'cancelled'
      ) {
        if (ev.type !== 'completed') {
          console.log(
            `[useWorkflowRuns] run ${ev.run.id} ${ev.type} ` +
              `(workflow=${ev.run.workflowName}, error=${ev.run.error ?? 'none'})`,
          );
        }
        setActiveRuns((cur) => removeKey(cur, ev.run.id));
        setControlProgress((cur) => removeKey(cur, ev.run.id));
        setRecentRuns((cur) => addRecentRun(cur, ev.run));
        // Schedule auto-dismissal with a status-dependent delay so failures
        // stay visible long enough to notice. Manual dismiss via
        // `dismissRecent` still works.
        dismissals.schedule(ev.run.id, ev.run.status);
      } else if (ev.type === 'step-spawned') {
        const { spec, focus } = stepSpawnedTerminal(ev, activeFolder);
        addTerminal(spec, focus);
      } else if (ev.type === 'workflow-task-spawned') {
        const { spec, focus } = workflowTaskSpawnedTerminal(ev, activeFolder);
        addTerminal(spec, focus);
      } else if (ev.type === 'step-control-progress') {
        setControlProgress((cur) => applyControlProgress(cur, ev));
      }
    });
    return () => {
      cancelled = true;
      dismissals.cancelAll();
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
    };
  }, [activeFolder, addTerminal]);

  const addActiveRun = useCallback((run: WorkflowRun) => {
    setActiveRuns((cur) => upsertRun(cur, run));
  }, []);

  return { activeRuns, recentRuns, controlProgress, addActiveRun, dismissRecent };
}
