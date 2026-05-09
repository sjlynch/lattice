import { useCallback, useEffect, useState } from 'react';
import {
  getActiveMergeRun,
  subscribeMergeRuns,
  type MergeRun,
} from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

// Hydrates and live-syncs the active merge-run for a project. The run is
// backend-driven; closing the panel/tab doesn't cancel it, so on every folder
// switch we refetch via /api/merge-runs/active and resubscribe to the WS for
// progress + conflict events. Conflict events spawn the resolver Claude as a
// merge-kind terminal (mirrors the per-card merge-button flow — the run
// worker has no UI access, so the frontend handles the terminal half).
export function useMergeRunSync(activeFolder: string, addTerminal: AddTerminal) {
  const [mergeRun, setMergeRun] = useState<MergeRun | null>(null);
  const [recentRunSummary, setRecentRunSummary] = useState<MergeRun | null>(
    null,
  );

  useEffect(() => {
    // Reset run state on every folder switch so a summary from project A
    // doesn't briefly flash when the user opens project B.
    setMergeRun(null);
    setRecentRunSummary(null);
    if (!activeFolder) return;
    let cancelled = false;
    getActiveMergeRun(activeFolder)
      .then((r) => {
        if (!cancelled) setMergeRun(r);
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
      } else if (ev.type === 'completed' || ev.type === 'cancelled') {
        setMergeRun(null);
        setRecentRunSummary(ev.run);
        // Auto-clear summary after a few seconds.
        setTimeout(() => {
          setRecentRunSummary((cur) => (cur?.id === ev.run.id ? null : cur));
        }, 8000);
      } else if (ev.type === 'conflict') {
        // Spawn the resolver Claude in the worktree. Same flow the per-card
        // merge button uses; the run worker doesn't have UI access so the
        // frontend handles the terminal half. Backend pre-spawns the pty
        // and ships the serverId in the event so the pane can lazy-mount.
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
    };
  }, [activeFolder, addTerminal]);

  const dismissRecent = useCallback(() => setRecentRunSummary(null), []);

  return { mergeRun, recentRunSummary, dismissRecent };
}
