import type { Task } from '../api';
import type { TerminalSpec } from '../TerminalsContext';

// Builds the taskId → terminalId lookup used by task-board focus buttons.
// A merge resolver and a worktree agent can both exist for the same task;
// the merge resolver is more actionable, so prefer merge-kind terminals.
export function buildTerminalMap(
  terminals: TerminalSpec[],
  tasks: Task[],
): Map<string, string> {
  const taskIds = new Set(tasks.map((task) => task.id));
  const terminalByTaskId = new Map<string, string>();

  for (const terminal of terminals) {
    if (!terminal.taskId || !taskIds.has(terminal.taskId)) continue;
    const existing = terminalByTaskId.get(terminal.taskId);
    if (!existing) {
      terminalByTaskId.set(terminal.taskId, terminal.id);
      continue;
    }
    if (terminal.kind === 'merge') terminalByTaskId.set(terminal.taskId, terminal.id);
  }

  return terminalByTaskId;
}
