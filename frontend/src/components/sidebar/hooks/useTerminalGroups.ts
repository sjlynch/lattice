import { useMemo } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

export function useTerminalGroups(terminals: TerminalSpec[], activeFolder: string) {
  // Per-project scoping: terminals are only listed when their projectPath
  // matches the current activeFolder. Legacy terminals saved without a
  // projectPath still show (treated as belonging to whatever's active).
  const projectTerminals = useMemo(
    () =>
      terminals.filter((t) => !t.projectPath || t.projectPath === activeFolder),
    [terminals, activeFolder],
  );
  const regularTerminals = useMemo(
    () => projectTerminals.filter((t) => t.kind !== 'merge' && t.kind !== 'startup'),
    [projectTerminals],
  );
  const mergeTerminals = useMemo(
    () => projectTerminals.filter((t) => t.kind === 'merge'),
    [projectTerminals],
  );
  const startupTerminalsList = useMemo(
    () => projectTerminals.filter((t) => t.kind === 'startup'),
    [projectTerminals],
  );

  return { projectTerminals, regularTerminals, mergeTerminals, startupTerminalsList };
}
