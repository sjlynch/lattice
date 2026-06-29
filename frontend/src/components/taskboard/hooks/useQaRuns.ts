import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchQaRunStatus,
  forgetQaRun as apiForgetQaRun,
  startQaRun as apiStartQaRun,
  type Task,
} from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../lanes';
import {
  pollWithErrorSentinel,
  useVisibilityPolling,
} from './useVisibilityPolling';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;
type CloseTerminal = (id: string) => void;

type ActiveQaRun = { runId: string; taskId: string; terminalId: string };

// Owns the QA-lane "run end-to-end test" buttons. Each run spawns a
// Playwright-enabled Claude session (backend `/api/qa-runs`) in its own
// terminal tab, then polls until the backend's Stop hook flips the run to
// `done` and closes the tab. Unlike push there can be several at once (one per
// QA task, or all of them via "run all"), so runs are tracked as a list.
//
// QA-run terminals deliberately carry NO `taskId`: the task is already in the
// `qa` lane, and `useTaskTerminalCleanup` closes every terminal tagged with a
// qa/done/deleted task's id — which would kill this terminal the instant it
// spawned. Like push runs, these are tracked here by terminal id instead.
export function useQaRuns(
  activeFolder: string,
  addTerminal: AddTerminal,
  closeTerminal: CloseTerminal,
  showError: (msg: string) => void,
) {
  const [activeRuns, setActiveRuns] = useState<ActiveQaRun[]>([]);
  // Tasks with an in-flight start request, so a double-click (or "run all"
  // overlapping a single run) doesn't spawn two sessions for one task before
  // the first lands in `activeRuns`.
  const startingRef = useRef<Set<string>>(new Set());

  // Drop everything when the project changes — the runs belong to the old
  // project's tasks and their terminals are scoped out by project anyway.
  useEffect(() => {
    setActiveRuns([]);
    startingRef.current = new Set();
  }, [activeFolder]);

  // Poll active runs; when the backend's Stop hook flips one to `done` (or it
  // 404s — already forgotten), close its terminal and forget it. The interval,
  // visibility pause/resume, and cancellation shell is shared with push polling;
  // QA-specific auto-close / verdict-preserving behavior stays here.
  const pollActiveRuns = useCallback(
    async (isCancelled: () => boolean) => {
      const settled: string[] = [];
      await Promise.all(
        activeRuns.map(async (run) => {
          // A *transient* fetch failure must not be treated as "run gone":
          // closing the terminal (which kills the pty) + forgetting the run
          // here would strand the agent's pending verdict, so a confident PASS
          // could never auto-advance the task to Done. fetchQaRunStatus returns
          // null only for a real 404 (genuinely gone); a thrown error (network
          // blip, backend momentarily busy) is caught to 'error' and skipped —
          // we just retry on the next tick.
          const status = await pollWithErrorSentinel(() =>
            fetchQaRunStatus(run.runId),
          );
          if (isCancelled() || status === 'error') return;
          if (!status || status.status === 'done') {
            // Tear down the terminal tab only when the run resolved with
            // auto-close enabled. The default (and a bare 404 — run already
            // gone) is to leave the terminal open so the user can read the
            // PASS/FAIL verdict and output. Either way, stop tracking + forget
            // the run so the registry doesn't grow.
            if (status && status.autoCloseTerminal) closeTerminal(run.terminalId);
            apiForgetQaRun(run.runId).catch(() => {});
            settled.push(run.runId);
          }
        }),
      );
      if (isCancelled() || settled.length === 0) return;
      const done = new Set(settled);
      setActiveRuns((prev) => prev.filter((r) => !done.has(r.runId)));
    },
    [activeRuns, closeTerminal],
  );

  useVisibilityPolling({
    enabled: activeRuns.length > 0,
    intervalMs: 2500,
    poll: pollActiveRuns,
  });

  const startQaRun = useCallback(
    async (task: Task) => {
      if (!activeFolder) return;
      if (startingRef.current.has(task.id)) return;
      startingRef.current.add(task.id);
      try {
        const res = await apiStartQaRun(activeFolder, task.id);
        const terminalId = addTerminal(
          {
            label: `qa:${shortLabel(task.title)}`,
            cwd: res.cwd,
            initialCommand: res.command,
            projectPath: activeFolder,
            serverId: res.serverId,
          },
          true,
        );
        setActiveRuns((prev) => [
          ...prev,
          { runId: res.id, taskId: task.id, terminalId },
        ]);
      } catch (err) {
        showError(`QA test failed to start: ${(err as Error).message}`);
      } finally {
        startingRef.current.delete(task.id);
      }
    },
    [activeFolder, addTerminal, showError],
  );

  const runningTaskIds = useMemo(
    () => new Set(activeRuns.map((r) => r.taskId)),
    [activeRuns],
  );

  const startAllQaRuns = useCallback(
    (tasks: Task[]) => {
      for (const task of tasks) {
        if (runningTaskIds.has(task.id)) continue;
        void startQaRun(task);
      }
    },
    [runningTaskIds, startQaRun],
  );

  return { startQaRun, startAllQaRuns, runningTaskIds };
}
