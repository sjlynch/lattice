import type { Persisted, TerminalSpec } from './terminalTypes';

// Active-id selection policies. Kept separate so the policy can be reasoned
// about without React state. Close fallbacks stay within the closed terminal's
// project-scoped panel (regular / merge / startup), so closing the last regular
// terminal leaves the Terminals panel empty instead of jumping to Startup.

type TerminalPanelKind = 'regular' | 'merge' | 'startup';

function terminalPanelKind(t: TerminalSpec): TerminalPanelKind {
  return t.kind === 'merge'
    ? 'merge'
    : t.kind === 'startup'
      ? 'startup'
      : 'regular';
}

function isSameFallbackGroup(
  terminal: TerminalSpec,
  target: TerminalSpec,
): boolean {
  return (
    terminalPanelKind(terminal) === terminalPanelKind(target) &&
    terminal.projectPath === target.projectPath
  );
}

function terminalsInFallbackGroup(
  terminals: TerminalSpec[],
  target: TerminalSpec,
): TerminalSpec[] {
  return terminals.filter((t) => isSameFallbackGroup(t, target));
}

export function pickInitialActiveId(persisted: Persisted): string | null {
  if (
    persisted.activeId &&
    persisted.terminals.some((t) => t.id === persisted.activeId)
  ) {
    return persisted.activeId;
  }
  return persisted.terminals[0]?.id ?? null;
}

export function pickActiveAfterAdd(
  current: string | null,
  newId: string,
  focus: boolean,
): string | null {
  // Even when the caller opts out of stealing focus (e.g. Run All on the task
  // board passes focus=false so each subsequent spawn doesn't yank the user
  // away), the *first* spawn should still focus when there's nothing focused
  // — otherwise Run All from an empty sidebar leaves the user staring at the
  // "No terminals yet" empty state.
  if (focus) return newId;
  if (current === null) return newId;
  return current;
}

export function pickActiveAfterClose(
  prevList: TerminalSpec[],
  nextList: TerminalSpec[],
  closedId: string,
  current: string | null,
): string | null {
  if (current !== closedId) return current;
  const closed = prevList.find((t) => t.id === closedId);
  if (!closed) return null;

  const prevPanelList = terminalsInFallbackGroup(prevList, closed);
  const nextPanelList = terminalsInFallbackGroup(nextList, closed);
  if (nextPanelList.length === 0) return null;

  const idx = prevPanelList.findIndex((t) => t.id === closedId);
  const fallbackIdx = Math.min(Math.max(0, idx), nextPanelList.length - 1);
  return nextPanelList[fallbackIdx]?.id ?? null;
}

export function pickActiveAfterCloseMany(
  prevList: TerminalSpec[],
  nextList: TerminalSpec[],
  closedIds: Set<string>,
  current: string | null,
): string | null {
  if (!current || !closedIds.has(current)) return current;
  const closed = prevList.find((t) => t.id === current);
  if (!closed) return null;

  const nextPanelList = terminalsInFallbackGroup(nextList, closed);
  if (nextPanelList.length === 0) return null;

  const idx = prevList.findIndex((t) => t.id === current);
  for (let i = idx - 1; i >= 0; i--) {
    const t = prevList[i];
    if (t && !closedIds.has(t.id) && isSameFallbackGroup(t, closed)) {
      return t.id;
    }
  }
  return nextPanelList[0]?.id ?? null;
}
