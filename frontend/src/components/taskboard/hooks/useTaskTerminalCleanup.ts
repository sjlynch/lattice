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
    // Index the few close-eligible terminals by task once, so each update
    // costs one lookup per task instead of a filter + map per finalized task
    // (most of a large board is qa/done, and this runs on every task frame).
    let byTask: Map<string, TerminalSpec[]> | undefined;
    for (const terminal of terminals) {
      if (!terminal.taskId || terminal.closeState) continue;
      byTask ??= new Map();
      const list = byTask.get(terminal.taskId);
      if (list) list.push(terminal);
      else byTask.set(terminal.taskId, [terminal]);
    }
    if (!byTask) return;
    for (const task of tasks) {
      const candidates = byTask.get(task.id);
      if (!candidates) continue;
      const finalized = task.status === 'qa' || task.status === 'done' || task.status === 'deleted';
      if (!finalized && task.status !== 'ready_to_merge') continue;
      const toClose: string[] = [];
      for (const terminal of candidates) {
        if (finalized || terminal.kind !== 'merge') toClose.push(terminal.id);
      }
      // Keep confirmation batches per task: one task's held DELETE must not
      // delay another task's confirmed removal.
      if (toClose.length > 0) closeTerminals(toClose);
    }
  }, [tasks, terminals, closeTerminals]);
}
