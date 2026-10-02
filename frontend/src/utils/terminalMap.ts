import type { TerminalSpec } from '../TerminalsContext';

// Builds the taskId → terminalId lookup used by task-board focus buttons.
// A merge resolver and a worktree agent can both exist for the same task;
// the merge resolver is more actionable, so prefer merge-kind terminals.
// Built from the terminals alone: lookups are only ever made with a rendered
// task's id, so filtering by the task list was redundant — and depending on it
// re-created the map (and every card's `getFocusTerminal`) on each board update.
export function buildTerminalMap(terminals: TerminalSpec[]): Map<string, string> {
  const terminalByTaskId = new Map<string, string>();

  for (const terminal of terminals) {
    if (!terminal.taskId) continue;
    const existing = terminalByTaskId.get(terminal.taskId);
    if (!existing) {
      terminalByTaskId.set(terminal.taskId, terminal.id);
      continue;
    }
    if (terminal.kind === 'merge') terminalByTaskId.set(terminal.taskId, terminal.id);
  }

  return terminalByTaskId;
}
