import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchQaRunStatus,
  forgetQaRun as apiForgetQaRun,
  mayHaveBeenApplied,
  retryTransient,
  startQaRun as apiStartQaRun,
  type Task,
} from '../../../api';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { shortLabel } from '../lanes';
import {
  pollWithErrorSentinel,
  useVisibilityPolling,
} from './useVisibilityPolling';

type AddTerminal = (spec: AddTerminalSpec, focus?: boolean) => string;
type CloseTerminal = (id: string) => void;

type ActiveQaRun = { runId: string; taskId: string; terminalId: string };

// The open terminal tabs (only their ids matter) + a way to focus one. Used to
// tell a run the user can still watch from one whose tab was closed.
type QaRunTerminals = {
  terminals: readonly { id: string }[];
  focusTerminal: (id: string) => void;
};

// A run whose tab the user closed killed its pty, so it will never report
// `done`: it must not keep the card in "testing…" or block a re-test (the
// backend likewise ignores a run whose pty is gone). Without a terminal list
// every tracked run counts as open.
function isTabOpen(run: ActiveQaRun, terminals: readonly { id: string }[] | undefined): boolean {
  return !terminals || terminals.some((t) => t.id === run.terminalId);
}

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
//
// One session per task: while a task's run is active (and its tab still open)
// the card's ▶ focuses that terminal instead of starting a second Claude +
// Playwright beside it — both would drive the same dev server and either
// one's confident PASS would promote the task. The backend refuses a duplicate
// start too (409); this just keeps the click from getting that far.
export function useQaRuns(
  activeFolder: string,
  addTerminal: AddTerminal,
  closeTerminal: CloseTerminal,
  showError: (msg: string) => void,
  tabs?: QaRunTerminals,
) {
  const [activeRuns, setActiveRuns] = useState<ActiveQaRun[]>([]);
  // Read by startQaRun, which must see a run recorded moments ago even when the
  // caller's closure predates that render ("run all" loops in one tick).
  const activeRunsRef = useRef<ActiveQaRun[]>(activeRuns);
  activeRunsRef.current = activeRuns;
  // Tasks with an in-flight start request, so a double-click (or "run all"
  // overlapping a single run) doesn't spawn two sessions for one task before
  // the first lands in `activeRuns`.
  const startingRef = useRef<Set<string>>(new Set());

  const terminals = tabs?.terminals;
  const focusTerminal = tabs?.focusTerminal;
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;

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
      const tracked = activeRunsRef.current.filter((r) => r.taskId === task.id);
      const live = tracked.find((r) => isTabOpen(r, terminalsRef.current));
      if (live) {
        focusTerminal?.(live.terminalId);
        return;
      }
      if (tracked.length > 0) {
        // Only closed-tab runs: stop showing them as running and let the
        // backend (which probes the pty) decide whether a new run may start.
        const stale = new Set(tracked.map((r) => r.runId));
        activeRunsRef.current = activeRunsRef.current.filter((r) => !stale.has(r.runId));
        setActiveRuns((prev) => prev.filter((r) => !stale.has(r.runId)));
      }
      startingRef.current.add(task.id);
      try {
        // As a push start: ride out a restart, never risk a second session.
        const res = await retryTransient(() => apiStartQaRun(activeFolder, task.id), {
          retryIf: (err) => !mayHaveBeenApplied(err),
        });
        const terminalId = addTerminal(
          {
            id: res.terminalId,
            label: `qa:${shortLabel(task.title)}`,
            cwd: res.cwd,
            initialCommand: res.command,
            projectPath: activeFolder,
            serverId: res.serverId,
          },
          true,
        );
        const run = { runId: res.id, taskId: task.id, terminalId };
        activeRunsRef.current = [...activeRunsRef.current, run];
        setActiveRuns((prev) => [...prev, run]);
      } catch (err) {
        showError(`QA test failed to start: ${(err as Error).message}`);
      } finally {
        startingRef.current.delete(task.id);
      }
    },
    [activeFolder, addTerminal, showError, focusTerminal],
  );

  // Tasks under test right now — drives the card's "testing…" button.
  const runningTaskIds = useMemo(
    () =>
      new Set(
        activeRuns.filter((r) => isTabOpen(r, terminals)).map((r) => r.taskId),
      ),
    [activeRuns, terminals],
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
