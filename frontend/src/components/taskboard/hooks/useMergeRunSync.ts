import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getActiveMergeRun,
  subscribeMergeRuns,
  type MergeRun,
  type MergeRunErrorEntry,
  type Task,
} from '../../../api';
import type { AddTerminal } from '../../../terminal/terminalTypes';

type CloseTerminalsForTask = (taskId: string, keep?: { id?: string; serverId?: string }) => void;
type ShowError = (msg: string) => void;

// How long a finished run's summary strip stays above Ready-to-Merge before auto-clearing.
const RECENT_RUN_SUMMARY_MS = 8000;

// Build a user-facing label for a per-task merge-run error. Resolves just the
// one task's title via `GET /api/tasks/:id` (project-pinned) — never the
// whole-board `fetchTasks`, which pulls every lane's full text (~1 MB on a big
// board) for one title. Falls back to the id.
async function buildErrorMessage(
  projectPath: string,
  entry: MergeRunErrorEntry,
): Promise<string> {
  const fallback = `Merge failed for task ${entry.taskId}: ${entry.error}`;
  try {
    const r = await fetch(
      `/api/tasks/${encodeURIComponent(entry.taskId)}?project=${encodeURIComponent(projectPath)}`,
    );
    if (!r.ok) return fallback;
    const task = (await r.json()) as Pick<Task, 'title'> | null;
    const title = task?.title?.trim();
    return title ? `Merge failed for "${title}": ${entry.error}` : fallback;
  } catch {
    return fallback;
  }
}

// Hydrates and live-syncs the active merge-run for a project. The run is
// backend-driven; closing the panel/tab doesn't cancel it, so on every folder
// switch we refetch via /api/merge-runs/active and resubscribe to the WS for
// progress + conflict events. Conflict events spawn the resolver Claude as a
// merge-kind terminal (mirrors the per-card merge-button flow — the run
// worker has no UI access, so the frontend handles the terminal half).
//
// Errors arrive in `run.errored[]` on progress/completed events. We diff
// against the last-seen set and toast each new entry via `showError` so the
// user actually sees what went wrong instead of just a "N errors" chip.
export function useMergeRunSync(
  activeFolder: string,
  addTerminal: AddTerminal,
  closeTerminalsForTask: CloseTerminalsForTask,
  showError?: ShowError,
) {
  const [mergeRun, setMergeRun] = useState<MergeRun | null>(null);
  const [recentRunSummary, setRecentRunSummary] = useState<MergeRun | null>(
    null,
  );

  // Toasted error keys (runId + taskId + error) so each unique failure
  // only toasts once even though it appears in every subsequent progress
  // event for the rest of the run.
  const toastedRef = useRef<Set<string>>(new Set());

  // Pending auto-clear timeout for the recent-run summary. Held in a ref so
  // an unmount / folder switch can cancel it instead of leaking a setState
  // that fires after the effect has been torn down.
  const summaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Reset run state on every folder switch so a summary from project A
    // doesn't briefly flash when the user opens project B.
    setMergeRun(null);
    setRecentRunSummary(null);
    toastedRef.current = new Set();
    if (!activeFolder) return;
    let cancelled = false;
    let receivedLiveState = false;

    function maybeToastErrors(run: MergeRun): void {
      if (!showError) return;
      for (const entry of run.errored) {
        const key = `${run.id}:${entry.taskId}:${entry.error}`;
        if (toastedRef.current.has(key)) continue;
        toastedRef.current.add(key);
        buildErrorMessage(activeFolder, entry)
          .then((msg) => {
            if (!cancelled) showError(msg);
          })
          .catch(() => {
            if (!cancelled) {
              showError(`Merge failed for task ${entry.taskId}: ${entry.error}`);
            }
          });
      }
    }

    getActiveMergeRun(activeFolder)
      .then((r) => {
        // The initial HTTP response can arrive after a newer WS event,
        // especially while reconnecting to a busy/recovering backend.
        if (cancelled || receivedLiveState) return;
        setMergeRun(r);
        if (r) maybeToastErrors(r);
      })
      .catch(() => {
        /* ignore */
      });
    const unsub = subscribeMergeRuns(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type !== 'conflict') receivedLiveState = true;
      if (ev.type === 'idle') {
        // Server confirmed no active run — clear any stale state left over
        // from a run that completed while the WS was disconnected.
        setMergeRun(null);
      } else if (ev.type === 'started' || ev.type === 'progress') {
        setMergeRun(ev.run);
        maybeToastErrors(ev.run);
      } else if (ev.type === 'completed' || ev.type === 'cancelled') {
        setMergeRun(null);
        setRecentRunSummary(ev.run);
        maybeToastErrors(ev.run);
        // Auto-clear summary after a few seconds. Track the handle so the
        // cleanup below can cancel a pending clear, and bail if the effect
        // has been cancelled (folder switch / unmount) before it fires.
        if (summaryTimerRef.current !== null) {
          clearTimeout(summaryTimerRef.current);
        }
        summaryTimerRef.current = setTimeout(() => {
          summaryTimerRef.current = null;
          if (cancelled) return;
          setRecentRunSummary((cur) => (cur?.id === ev.run.id ? null : cur));
        }, RECENT_RUN_SUMMARY_MS);
      } else if (ev.type === 'conflict') {
        // Spawn the resolver Claude in the worktree. Same flow the per-card
        // merge button uses; the run worker doesn't have UI access so the
        // frontend handles the terminal half. Backend pre-spawns the pty
        // and ships the serverId in the event so the pane can lazy-mount.
        // Drop any stale tab for this task first (a resolver abort → re-merge
        // re-emits `conflict` with a fresh serverId) so one task never owns two
        // merge-kind tabs — the same replace-don't-duplicate rule the
        // `task-spawned` handler applies. And the same exemption: never the
        // fresh resolver's own tab. The registry's `upsert` for it usually
        // lands BEFORE this event and has already mounted it (tagged with
        // this taskId), so a plain per-task close DELETEd the resolver ~20 ms
        // after it spawned — the run then saw it dead, stopped, and a workflow
        // Merge step failed with "made no progress" (2026-09-25).
        closeTerminalsForTask(ev.taskId, { id: ev.terminalId, serverId: ev.serverId });
        addTerminal({
          id: ev.terminalId,
          label: `merge:${ev.taskId.slice(-6)}`,
          cwd: ev.cwd,
          initialCommand: ev.command,
          taskId: ev.taskId,
          kind: 'merge',
          projectPath: activeFolder,
          serverId: ev.serverId,
        }, false);
      }
    });
    return () => {
      cancelled = true;
      unsub();
      if (summaryTimerRef.current !== null) {
        clearTimeout(summaryTimerRef.current);
        summaryTimerRef.current = null;
      }
    };
  }, [activeFolder, addTerminal, closeTerminalsForTask, showError]);

  const dismissRecent = useCallback(() => setRecentRunSummary(null), []);

  return { mergeRun, recentRunSummary, dismissRecent };
}
