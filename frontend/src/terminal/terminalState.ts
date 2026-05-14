import type { Persisted, TerminalSpec } from './terminalTypes';

export function newTerminalId(): string {
  return `term_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function addTerminalToList(
  terminals: TerminalSpec[],
  spec: Omit<TerminalSpec, 'id'>,
  id: string,
): TerminalSpec[] {
  return [...terminals, { ...spec, id }];
}

export function removeTerminalFromList(
  terminals: TerminalSpec[],
  id: string,
): TerminalSpec[] {
  return terminals.filter((t) => t.id !== id);
}

export function removeTerminalsFromList(
  terminals: TerminalSpec[],
  idSet: Set<string>,
): TerminalSpec[] {
  return terminals.filter((t) => !idSet.has(t.id));
}

export function setServerIdInList(
  terminals: TerminalSpec[],
  id: string,
  serverId: string,
): TerminalSpec[] {
  return terminals.map((t) => (t.id === id ? { ...t, serverId } : t));
}

// Active-id selection policies. Kept separate so the policy can be reasoned
// about without React state. Single-close clamps the previous index into the
// new list; multi-close walks backward to the first surviving terminal,
// which feels less jumpy when several adjacent tabs are closed at once.

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
  if (nextList.length === 0) return null;
  const idx = prevList.findIndex((t) => t.id === closedId);
  const fallbackIdx = Math.min(Math.max(0, idx), nextList.length - 1);
  return nextList[fallbackIdx]?.id ?? null;
}

export function pickActiveAfterCloseMany(
  prevList: TerminalSpec[],
  nextList: TerminalSpec[],
  closedIds: Set<string>,
  current: string | null,
): string | null {
  if (!current || !closedIds.has(current)) return current;
  if (nextList.length === 0) return null;
  const idx = prevList.findIndex((t) => t.id === current);
  for (let i = idx - 1; i >= 0; i--) {
    const t = prevList[i];
    if (t && !closedIds.has(t.id)) return t.id;
  }
  return nextList[0]?.id ?? null;
}
