import { useCallback, useMemo } from 'react';
import type { Task } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import { buildTerminalMap } from '../../../utils/terminalMap';

// Terminal focus helpers for the launcher. Maps tasks → their pty so a card's
// focus button can activate the matching terminal tab, and exposes a
// serverId-based focuser for the post-merge hook row (which has no task).
// The map depends on `terminals` only, so `getFocusTerminal` keeps its identity
// across board updates and React.memo(TaskCard) can skip unchanged cards.
// `tasks` stays in the signature for callers; lookups use a card's own task.
export function useTaskTerminalFocus(
  terminals: TerminalSpec[],
  _tasks: Task[],
  setActiveId: (id: string) => void,
) {
  const terminalByTaskId = useMemo(
    () => buildTerminalMap(terminals),
    [terminals],
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
