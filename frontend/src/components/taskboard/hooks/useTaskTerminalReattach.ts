import { useEffect, useRef } from 'react';
import type { Task } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../lanes';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

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
  const activeFolderRef = useRef(activeFolder);
  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);
  useEffect(() => {
    activeFolderRef.current = activeFolder;
  }, [activeFolder]);

  useEffect(() => {
    if (!activeFolder) return;
    if (reattachedFor.current === activeFolder) return;
    const inProgress = tasks.filter(
      (t) => t.status === 'in_progress' && !!t.worktreePath,
    );
    // Tasks may not have loaded on the first render — wait for them before
    // claiming the one-shot (the guard is set only once there is work).
    if (inProgress.length === 0) return;
    reattachedFor.current = activeFolder;

    void (async () => {
      let sessions: Array<{ id: string; cwd: string }>;
      try {
        const r = await fetch('/api/terminals');
        if (!r.ok) return;
        sessions = await r.json();
      } catch {
        return;
      }
      // The user switched projects while we were fetching — drop the result.
      if (activeFolderRef.current !== activeFolder) return;

      const mounted = terminalsRef.current;
      const mountedTaskIds = new Set(
        mounted.map((t) => t.taskId).filter(Boolean),
      );
      const mountedServerIds = new Set(
        mounted.map((t) => t.serverId).filter(Boolean),
      );

      for (const task of inProgress) {
        if (mountedTaskIds.has(task.id)) continue;
        const wt = normalizePath(task.worktreePath as string);
        const session = sessions.find(
          (s) => normalizePath(s.cwd) === wt && !mountedServerIds.has(s.id),
        );
        if (!session) continue;
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
        mountedServerIds.add(session.id);
      }
    })();
  }, [activeFolder, tasks, addTerminal]);
}
