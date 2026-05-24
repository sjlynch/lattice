import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminals } from '../../../TerminalsContext';
import {
  fetchActiveWorkflowRuns,
  subscribeWorkflowRuns,
  type WorkflowRun,
  type WorkflowStepKind,
} from '../../../api';
import { shortLabel } from '../../taskboard/lanes';

// Latest progress snapshot for a control-flow step. Keyed by runId; only the
// currently-executing step's progress is retained (next step replaces it).
export type ControlProgress = {
  stepIndex: number;
  kind: WorkflowStepKind;
  current: number;
  total: number;
  message?: string;
};

// Recent-run linger windows. Completed runs disappear quickly (10s) so the
// chip area stays uncluttered, but errored/cancelled runs linger long enough
// (5min) that a user who stepped away from the screen still sees the failure
// signal when they return. Both can be dismissed manually via `dismissRecent`.
const COMPLETED_LINGER_MS = 10_000;
const ERRORED_LINGER_MS = 5 * 60 * 1000;

// Re-fetch the active-runs HTTP endpoint when this fraction of stale time has
// passed since the last fetch on visibility return. Cheap belt-and-braces in
// case a WS event was lost while the tab was hidden — additive only, so a
// stale fetch can't remove a run.
const VISIBILITY_REFETCH_MIN_INTERVAL_MS = 2000;

// Tracks live workflow runs (`/ws/workflow-runs`) and hands per-step terminal
// spawns to the global TerminalsContext. Recently-finished runs linger in
// `recentRuns` for ~10s (completed) or 5min (errored/cancelled) so the UI can
// surface failures even after the user looks away from the screen.
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
  const [activeRuns, setActiveRuns] = useState<Record<string, WorkflowRun>>({});
  const [recentRuns, setRecentRuns] = useState<Record<string, WorkflowRun>>({});
  const [controlProgress, setControlProgress] = useState<
    Record<string, ControlProgress>
  >({});
  const { addTerminal } = useTerminals();

  // Mirrored so the additive fetch reconciler can read the freshest known
  // recent-runs map without re-running on every state change.
  const recentRunsRef = useRef(recentRuns);
  recentRunsRef.current = recentRuns;

  useEffect(() => {
    if (!activeFolder) {
      setActiveRuns({});
      setControlProgress({});
      return;
    }
    let cancelled = false;

    // Schedule the deferred removal of a recent run, with a status-dependent
    // delay so errored/cancelled runs stay visible long enough for the user
    // to notice them. Captured in the effect so cancellation can wipe pending
    // timers on activeFolder change.
    const pendingDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
    function scheduleRecentDismissal(id: string, status: WorkflowRun['status']) {
      const delay =
        status === 'completed' ? COMPLETED_LINGER_MS : ERRORED_LINGER_MS;
      const prev = pendingDismissTimers.get(id);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        pendingDismissTimers.delete(id);
        if (cancelled) return;
        setRecentRuns((cur) => {
          if (!cur[id]) return cur;
          const next = { ...cur };
          delete next[id];
          return next;
        });
      }, delay);
      pendingDismissTimers.set(id, t);
    }

    // Additive reconciler: merge `fetched` into `activeRuns` without removing
    // anything. A run in `recentRuns` was finalized by a WS event we already
    // saw — don't resurrect it from a stale fetch.
    function applyFetched(fetched: WorkflowRun[], origin: string) {
      if (cancelled) return;
      setActiveRuns((cur) => {
        let addedIds: string[] = [];
        const next = { ...cur };
        for (const r of fetched) {
          if (next[r.id]) continue;
          if (recentRunsRef.current[r.id]) continue;
          next[r.id] = r;
          addedIds.push(r.id);
        }
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
        const map: Record<string, WorkflowRun> = {};
        for (const r of ev.runs) map[r.id] = r;
        console.log(
          `[useWorkflowRuns] hello: ${ev.runs.length} active run(s) ` +
            `(project=${activeFolder})`,
        );
        setActiveRuns(map);
      } else if (ev.type === 'started' || ev.type === 'progress') {
        setActiveRuns((cur) => ({ ...cur, [ev.run.id]: ev.run }));
        // A step advance ('progress' is fired after step-spawned for agent
        // steps) means whatever control-progress we were showing for the
        // prior step is stale. Drop it; the next step's first progress event
        // will replace it.
        setControlProgress((cur) => {
          const prev = cur[ev.run.id];
          if (!prev || prev.stepIndex === ev.run.currentStepIndex) return cur;
          const next = { ...cur };
          delete next[ev.run.id];
          return next;
        });
      } else if (ev.type === 'completed' || ev.type === 'errored' || ev.type === 'cancelled') {
        if (ev.type !== 'completed') {
          console.log(
            `[useWorkflowRuns] run ${ev.run.id} ${ev.type} ` +
              `(workflow=${ev.run.workflowName}, error=${ev.run.error ?? 'none'})`,
          );
        }
        setActiveRuns((cur) => {
          const next = { ...cur };
          delete next[ev.run.id];
          return next;
        });
        setControlProgress((cur) => {
          if (!cur[ev.run.id]) return cur;
          const next = { ...cur };
          delete next[ev.run.id];
          return next;
        });
        setRecentRuns((cur) => ({ ...cur, [ev.run.id]: ev.run }));
        // Schedule auto-dismissal with a status-dependent delay so failures
        // stay visible long enough to notice. Manual dismiss via
        // `dismissRecent` still works.
        scheduleRecentDismissal(ev.run.id, ev.run.status);
      } else if (ev.type === 'step-spawned') {
        addTerminal({
          label: `wf:step${ev.stepIndex + 1}`,
          cwd: ev.cwd,
          initialCommand: ev.command,
          projectPath: activeFolder,
          serverId: ev.serverId,
        });
      } else if (ev.type === 'workflow-task-spawned') {
        // Start control step fans out one task agent per Open task. Make
        // each one visible in the sidebar — tagging with taskId lets
        // useTaskTerminalCleanup auto-close it when the task moves out
        // of in_progress.
        addTerminal({
          label: shortLabel(ev.title),
          cwd: ev.cwd,
          initialCommand: ev.command,
          taskId: ev.taskId,
          projectPath: activeFolder,
          serverId: ev.serverId,
        }, false);
      } else if (ev.type === 'step-control-progress') {
        setControlProgress((cur) => ({
          ...cur,
          [ev.runId]: {
            stepIndex: ev.stepIndex,
            kind: ev.kind,
            current: ev.current,
            total: ev.total,
            message: ev.message,
          },
        }));
      }
    });
    return () => {
      cancelled = true;
      for (const t of pendingDismissTimers.values()) clearTimeout(t);
      pendingDismissTimers.clear();
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
    };
  }, [activeFolder, addTerminal]);

  const addActiveRun = useCallback((run: WorkflowRun) => {
    setActiveRuns((cur) => ({ ...cur, [run.id]: run }));
  }, []);

  const dismissRecent = useCallback((id: string) => {
    setRecentRuns((cur) => {
      if (!cur[id]) return cur;
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);

  return { activeRuns, recentRuns, controlProgress, addActiveRun, dismissRecent };
}
