import { useMemo } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';
import { terminalBelongsToProject } from '../../../terminal/terminalScope';

export function useTerminalGroups(terminals: TerminalSpec[], activeFolder: string) {
  // Per-project scoping: terminals are only listed when they belong to the
  // current activeFolder. A terminal with a recorded projectPath matches that
  // project exactly; a LEGACY terminal saved without a projectPath is scoped by
  // its cwd (shown only when cwd equals/descends from activeFolder) rather than
  // falling through to whatever project is active — that catch-all let a
  // wrong-repo shell appear (and be auto-selected) in every project. See
  // terminalScope.ts.
  const projectTerminals = useMemo(
    () => terminals.filter((t) => terminalBelongsToProject(t, activeFolder)),
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
