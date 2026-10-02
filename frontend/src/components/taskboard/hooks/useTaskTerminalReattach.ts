import { useEffect, useRef } from 'react';
import type { Task } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../lanes';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

export const TASK_TERMINAL_REATTACH_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

// Normalize a path for comparison: forward slashes, no trailing slash,
// lower-case (Windows paths are case-insensitive).
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// On board load, re-attach terminals for in_progress tasks whose worktree
// agent pty is still alive in the terminal-server but is NOT mounted as a
// terminal tab in this browser tab.
//
// Closes the spawn-queue "known gap": a queued task admitted while every
// browser tab was closed never delivered its `task-spawned` event, so its
// terminal was never mounted — the work ran, but the terminal is orphaned
// from the UI. Also covers opening the board in a fresh tab after a backend
// restart (the detached terminal-server keeps ptys alive across restarts).
//
// Runs once per project: a live spawn while the board is open is delivered
// by the `task-spawned` WS event (useTaskList), not this hook.
export function useTaskTerminalReattach(
  activeFolder: string,
  tasks: Task[],
  terminals: TerminalSpec[],
  addTerminal: AddTerminal,
): void {
  // Folder this hook has already done its one-shot reattach for.
  const reattachedFor = useRef<string | null>(null);
  // Latest values mirrored into refs so the effect can read them without
  // re-subscribing on every change.
  const terminalsRef = useRef(terminals);
  const tasksRef = useRef(tasks);
  const activeFolderRef = useRef(activeFolder);
  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    activeFolderRef.current = activeFolder;
  }, [activeFolder]);

  // The effect is keyed on the SET of reattachable tasks, not the task array:
  // every `/ws/tasks` snapshot is a new array, and depending on it re-ran the
  // effect (cancelling the in-flight retry chain and restarting it at attempt
  // 0) on every update — on a busy board the one-shot never completed and
  // `/api/terminals` was polled indefinitely.
  // Once this folder's one-shot has run the effect bails before reading the
  // key, so skip the filter/sort/join on every later task update. The ref only
  // flips at the end of a completed chain (nothing left in flight), and a
  // folder switch makes it unequal again, so the one-shot fires exactly as
  // before.
  // eslint-disable-next-line react-hooks/refs -- read-only short-circuit; see above
  const reattachDone = reattachedFor.current === activeFolder;
  const inProgressKey = reattachDone
    ? ''
    : tasks
        .filter((t) => t.status === 'in_progress' && !!t.worktreePath)
        .map((t) => t.id)
        .sort()
        .join('\n');

  useEffect(() => {
    if (!activeFolder) return;
    if (reattachedFor.current === activeFolder) return;
    // Tasks may not have loaded on the first render — wait for them before
    // starting the one-shot reattach attempt.
    if (!inProgressKey) return;
    const inProgress = tasksRef.current.filter(
      (t) => t.status === 'in_progress' && !!t.worktreePath,
    );

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = (attempt: number) => {
      if (cancelled || activeFolderRef.current !== activeFolder) return;
      const delay = TASK_TERMINAL_REATTACH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        // Bounded backoff exhausted: consider the one-shot complete for this
        // folder so every task-list update does not poll /api/terminals forever.
        reattachedFor.current = activeFolder;
        return;
      }
      retryTimer = setTimeout(() => {
        void attemptReattach(attempt + 1);
      }, delay);
    };

    const attemptReattach = async (attempt: number) => {
      let sessions: Array<{ id: string; cwd: string }>;
      try {
        const r = await fetch('/api/terminals');
        if (!r.ok) throw new Error(`terminal list failed: ${r.status}`);
        const parsed = await r.json();
        if (!Array.isArray(parsed)) throw new Error('terminal list was not an array');
        sessions = parsed as Array<{ id: string; cwd: string }>;
      } catch {
        scheduleRetry(attempt);
        return;
      }
      // The user switched projects while we were fetching — drop the result.
      if (cancelled || activeFolderRef.current !== activeFolder) return;

      const mounted = terminalsRef.current;
      const mountedTaskIds = new Set(
        mounted.map((t) => t.taskId).filter(Boolean),
      );
      const mountedServerIds = new Set(
        mounted.map((t) => t.serverId).filter(Boolean),
      );
      let missingSession = false;

      for (const task of inProgress) {
        if (mountedTaskIds.has(task.id)) continue;
        const wt = normalizePath(task.worktreePath as string);
        const session = sessions.find(
          (s) => normalizePath(s.cwd) === wt && !mountedServerIds.has(s.id),
        );
        if (!session) {
          missingSession = true;
          continue;
        }
        // No initialCommand — the pty is already running; the spec attaches
        // to the live session by serverId and replays its buffer.
        addTerminal(
          {
            label: shortLabel(task.title),
            cwd: task.worktreePath as string,
            taskId: task.id,
            projectPath: task.projectPath,
            serverId: session.id,
          },
          false,
        );
        mountedTaskIds.add(task.id);
        mountedServerIds.add(session.id);
      }

      if (missingSession) {
        scheduleRetry(attempt);
        return;
      }
      // Claim the guard only after a successful /api/terminals response (and
      // after any no-session startup race has either resolved or exhausted the
      // bounded retry above). Transient HTTP/JSON failures therefore do not
      // permanently suppress reattach for this project.
      reattachedFor.current = activeFolder;
    };

    void attemptReattach(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [activeFolder, inProgressKey, addTerminal]);
}
