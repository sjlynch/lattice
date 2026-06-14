import { useCallback, useMemo } from 'react';
import { type Task } from '../../../api';
import { type TerminalSpec } from '../../../TerminalsContext';
import { buildTerminalMap } from '../../../utils/terminalMap';

// Terminal focus helpers for the launcher. Maps tasks → their pty so a card's
// focus button can activate the matching terminal tab, and exposes a
// serverId-based focuser for the post-merge hook row (which has no task).
export function useTaskTerminalFocus(
  terminals: TerminalSpec[],
  tasks: Task[],
  setActiveId: (id: string) => void,
) {
  const terminalByTaskId = useMemo(
    () => buildTerminalMap(terminals, tasks),
    [terminals, tasks],
  );

  const getFocusTerminal = useCallback(
    (task: Task): (() => void) | null => {
      const termId = terminalByTaskId.get(task.id);
      if (!termId) return null;
      return () => setActiveId(termId);
    },
    [terminalByTaskId, setActiveId],
  );

  const focusTerminalByServerId = useCallback(
    (serverId: string | undefined | null): (() => void) | null => {
      if (!serverId) return null;
      return () => {
        const term = terminals.find((t) => t.serverId === serverId);
        if (term) setActiveId(term.id);
      };
    },
    [terminals, setActiveId],
  );

  return { getFocusTerminal, focusTerminalByServerId };
}
