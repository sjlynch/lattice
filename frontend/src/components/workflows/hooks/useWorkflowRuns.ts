import { useCallback, useEffect, useState } from 'react';
import { useTerminals } from '../../../TerminalsContext';
import { subscribeWorkflowRuns, type WorkflowRun } from '../../../api';

// Tracks live workflow runs (`/ws/workflow-runs`) and hands per-step terminal
// spawns to the global TerminalsContext. Recently-finished runs linger in
// `recentRuns` for ~10s so the UI can render a summary strip.
export function useWorkflowRuns(activeFolder: string) {
  const [activeRuns, setActiveRuns] = useState<Record<string, WorkflowRun>>({});
  const [recentRuns, setRecentRuns] = useState<Record<string, WorkflowRun>>({});
  const { addTerminal } = useTerminals();

  useEffect(() => {
    if (!activeFolder) {
      setActiveRuns({});
      return;
    }
    let cancelled = false;
    const unsub = subscribeWorkflowRuns(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type === 'hello') {
        const map: Record<string, WorkflowRun> = {};
        for (const r of ev.runs) map[r.id] = r;
        setActiveRuns(map);
      } else if (ev.type === 'started' || ev.type === 'progress') {
        setActiveRuns((cur) => ({ ...cur, [ev.run.id]: ev.run }));
      } else if (ev.type === 'completed' || ev.type === 'errored' || ev.type === 'cancelled') {
        setActiveRuns((cur) => {
          const next = { ...cur };
          delete next[ev.run.id];
          return next;
        });
        setRecentRuns((cur) => ({ ...cur, [ev.run.id]: ev.run }));
        const id = ev.run.id;
        setTimeout(() => {
          setRecentRuns((cur) => {
            if (!cur[id]) return cur;
            const next = { ...cur };
            delete next[id];
            return next;
          });
        }, 10000);
      } else if (ev.type === 'step-spawned') {
        addTerminal({
          label: `wf:step${ev.stepIndex + 1}`,
          cwd: ev.cwd,
          initialCommand: ev.command,
          projectPath: activeFolder,
          serverId: ev.serverId,
        });
      }
    });
    return () => { cancelled = true; unsub(); };
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

  return { activeRuns, recentRuns, addActiveRun, dismissRecent };
}
