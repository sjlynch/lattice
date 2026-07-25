import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchTasks,
  getActiveMergeRun,
  subscribeMergeRuns,
  type MergeRun,
  type MergeRunErrorEntry,
} from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;
type CloseTerminalsForTask = (taskId: string) => void;
type ShowError = (msg: string) => void;

// Build a user-facing label for a per-task merge-run error. Resolves the
// task title at call time so a fresh fetch isn't needed in the common case
// (the task list is already in the tab's state via subscribeTasks).
async function buildErrorMessage(
  projectPath: string,
  entry: MergeRunErrorEntry,
): Promise<string> {
  try {
    const tasks = await fetchTasks(projectPath);
    const task = tasks.find((t) => t.id === entry.taskId);
    const title = task?.title?.trim();
    return title
      ? `Merge failed for "${title}": ${entry.error}`
      : `Merge failed for task ${entry.taskId}: ${entry.error}`;
  } catch {
    return `Merge failed for task ${entry.taskId}: ${entry.error}`;
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
        if (cancelled) return;
        setMergeRun(r);
        if (r) maybeToastErrors(r);
      })
      .catch(() => {
        /* ignore */
      });
    const unsub = subscribeMergeRuns(activeFolder, (ev) => {
      if (cancelled) return;
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
        }, 8000);
      } else if (ev.type === 'conflict') {
        // Spawn the resolver Claude in the worktree. Same flow the per-card
        // merge button uses; the run worker doesn't have UI access so the
        // frontend handles the terminal half. Backend pre-spawns the pty
        // and ships the serverId in the event so the pane can lazy-mount.
        // Drop any stale tab for this task first (a resolver abort → re-merge
        // re-emits `conflict` with a fresh serverId) so one task never owns two
        // merge-kind tabs — the same replace-don't-duplicate rule the
        // `task-spawned` handler applies.
        closeTerminalsForTask(ev.taskId);
        addTerminal({
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
