import { useCallback, useEffect, useState } from 'react';
import { useTerminals } from '../../../TerminalsContext';
import {
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

// Tracks live workflow runs (`/ws/workflow-runs`) and hands per-step terminal
// spawns to the global TerminalsContext. Recently-finished runs linger in
// `recentRuns` for ~10s so the UI can render a summary strip.
export function useWorkflowRuns(activeFolder: string) {
  const [activeRuns, setActiveRuns] = useState<Record<string, WorkflowRun>>({});
  const [recentRuns, setRecentRuns] = useState<Record<string, WorkflowRun>>({});
  const [controlProgress, setControlProgress] = useState<
    Record<string, ControlProgress>
  >({});
  const { addTerminal } = useTerminals();

  useEffect(() => {
    if (!activeFolder) {
      setActiveRuns({});
      setControlProgress({});
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

  return { activeRuns, recentRuns, controlProgress, addActiveRun, dismissRecent };
}
