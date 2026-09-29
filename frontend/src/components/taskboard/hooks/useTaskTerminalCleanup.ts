import { useEffect } from 'react';
import type { Task } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';

// Owns taskboard terminal lifecycle cleanup. Task-level terminal statuses close
// every terminal for that task; ready-to-merge closes only the original
// non-merge worktree-agent terminal, leaving conflict resolvers alone.
export function useTaskTerminalCleanup(
  tasks: Task[],
  terminals: TerminalSpec[],
  closeTerminals: (ids: string[]) => void,
) {
  // Reconcile task transitions and tabs arriving later from cache/registry.
  // Closing and failed tabs already have a close intent: pending confirmation
  // must stay idle, and a failure must wait for the user's explicit retry.
  useEffect(() => {
    for (const task of tasks) {
      const finalized = task.status === 'qa' || task.status === 'done' || task.status === 'deleted';
      if (!finalized && task.status !== 'ready_to_merge') continue;
      const toClose = terminals
        .filter((terminal) => terminal.taskId === task.id && !terminal.closeState
          && (finalized || terminal.kind !== 'merge'))
        .map((terminal) => terminal.id);
      // Keep confirmation batches per task: one task's held DELETE must not
      // delay another task's confirmed removal.
      if (toClose.length > 0) closeTerminals(toClose);
    }
  }, [tasks, terminals, closeTerminals]);
}
