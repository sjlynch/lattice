import { useEffect } from 'react';
import type { Task } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';

// Owns taskboard terminal lifecycle cleanup. Task-level terminal statuses close
// every terminal for that task; ready-to-merge closes only the original
// non-merge worktree-agent terminal, leaving conflict resolvers alone.
export function useTaskTerminalCleanup(
  tasks: Task[],
  terminals: TerminalSpec[],
  closeTerminalsForTask: (taskId: string) => void,
  closeTerminals: (ids: string[]) => void,
) {
  // Auto-close terminals when their task reaches a terminal state. Runs on
  // every task update so it also catches stale sessionStorage terminals that
  // survive a server restart.
  useEffect(() => {
    for (const task of tasks) {
      if (
        task.status === 'qa' ||
        task.status === 'done' ||
        task.status === 'deleted'
      ) {
        closeTerminalsForTask(task.id);
      }
    }
  }, [tasks, closeTerminalsForTask]);

  // Close the original worktree-Claude terminal when its task moves to
  // ready_to_merge — the in-progress agent has committed and the pty is just
  // sitting idle. Merge-kind terminals (conflict resolvers spawned *after* the
  // move) are left alone; they get closed by the qa/done/deleted effect above
  // when the task finalizes.
  useEffect(() => {
    const readyIds = new Set(
      tasks
        .filter((task) => task.status === 'ready_to_merge')
        .map((task) => task.id),
    );
    if (readyIds.size === 0) return;
    const toClose = terminals
      .filter(
        (terminal) =>
          terminal.taskId &&
          readyIds.has(terminal.taskId) &&
          terminal.kind !== 'merge',
      )
      .map((terminal) => terminal.id);
    if (toClose.length > 0) closeTerminals(toClose);
  }, [tasks, terminals, closeTerminals]);
}
