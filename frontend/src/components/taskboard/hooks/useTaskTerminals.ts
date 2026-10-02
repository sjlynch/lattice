import { type Task } from '../../../api';
import { type TerminalSpec } from '../../../TerminalsContext';
import type { AddTerminal } from '../../../terminal/terminalTypes';
import { useTaskTerminalCleanup } from './useTaskTerminalCleanup';
import { useTaskTerminalFocus } from './useTaskTerminalFocus';
import { useTaskTerminalReattach } from './useTaskTerminalReattach';

type UseTaskTerminalsArgs = {
  activeFolder: string;
  tasks: Task[];
  terminals: TerminalSpec[];
  addTerminal: AddTerminal;
  closeTerminals: (ids: string[]) => void;
  setActiveId: (id: string) => void;
};

// Composes the taskboard's three terminal-lifecycle hooks so the launcher wires
// them in one call: the task→pty focus map (plus the serverId focuser the
// post-merge hook row uses), the auto-cleanup on lifecycle transitions, and the
// one-shot reattach for live-but-unmounted worktree ptys. Only the focus
// helpers are returned — cleanup/reattach are effect-only.
export function useTaskTerminals({
  activeFolder,
  tasks,
  terminals,
  addTerminal,
  closeTerminals,
  setActiveId,
}: UseTaskTerminalsArgs) {
  const { getFocusTerminal, focusTerminalByServerId } = useTaskTerminalFocus(
    terminals,
    tasks,
    setActiveId,
  );

  useTaskTerminalCleanup(
    tasks,
    terminals,
    closeTerminals,
  );

  // Re-mount terminals for in_progress tasks whose pty is still alive but was
  // never delivered to this tab (queued task admitted while all tabs were
  // closed; fresh tab after a backend restart).
  useTaskTerminalReattach(activeFolder, tasks, terminals, addTerminal);

  return { getFocusTerminal, focusTerminalByServerId };
}
