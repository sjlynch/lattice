import type { TerminalSpec, TerminalStatus } from './terminalTypes';

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

// The ids of every terminal belonging to a task. Collected in one pass so a
// batched close can remove them all atomically — looping a single-close that
// re-reads a stale snapshot per id drops all-but-one setState and "resurrects"
// the siblings it already removed.
export function terminalIdsForTask(
  terminals: TerminalSpec[],
  taskId: string,
): string[] {
  return terminals.filter((t) => t.taskId === taskId).map((t) => t.id);
}

// Plan a batched close: which backend serverIds need a DELETE and what the
// terminal list looks like afterwards. Walks the list once and dedupes on the
// id set, so a serverId is returned at most once even if `closedIds` repeats an
// id — the DELETE side effect must fire exactly once per session (a double
// DELETE in <100ms crashed node-pty's Windows helper, see TerminalsContext).
export function planCloseTerminals(
  terminals: TerminalSpec[],
  closedIds: Set<string>,
): { serverIdsToDelete: string[]; next: TerminalSpec[] } {
  const serverIdsToDelete: string[] = [];
  for (const t of terminals) {
    if (closedIds.has(t.id) && t.serverId) serverIdsToDelete.push(t.serverId);
  }
  return {
    serverIdsToDelete,
    next: removeTerminalsFromList(terminals, closedIds),
  };
}

export function setServerIdInList(
  terminals: TerminalSpec[],
  id: string,
  serverId: string,
): TerminalSpec[] {
  return terminals.map((t) => (t.id === id ? { ...t, serverId } : t));
}

// Set a terminal's connection-health status (and optional pty exit code).
// Returns the SAME array reference when nothing changed, so a repeated status
// report (e.g. `live` on every successful (re)connect) doesn't churn renders of
// the whole tab strip.
export function setStatusInList(
  terminals: TerminalSpec[],
  id: string,
  status: TerminalStatus,
  exitCode?: number,
): TerminalSpec[] {
  const target = terminals.find((t) => t.id === id);
  if (!target) return terminals;
  if (target.status === status && target.exitCode === exitCode) return terminals;
  return terminals.map((t) =>
    t.id === id ? { ...t, status, exitCode } : t,
  );
}

export function renameTerminalInList(
  terminals: TerminalSpec[],
  id: string,
  label: string,
): TerminalSpec[] {
  return terminals.map((t) => (t.id === id ? { ...t, label } : t));
}

// Move `draggedId` to sit next to `targetId` in the full list. Operates on
// ids (not indices) so it stays correct even though the tab strip only shows
// a project/panel-scoped, optionally search-filtered subset of `terminals`.
// When dragging forward (left→right) the tab lands after the target; when
// dragging backward it lands before — matching the dropped tab's visual
// position.
export function reorderTerminalInList(
  terminals: TerminalSpec[],
  draggedId: string,
  targetId: string,
): TerminalSpec[] {
  if (draggedId === targetId) return terminals;
  const from = terminals.findIndex((t) => t.id === draggedId);
  const to = terminals.findIndex((t) => t.id === targetId);
  if (from === -1 || to === -1) return terminals;
  const next = [...terminals];
  const [moved] = next.splice(from, 1);
  const insertAt = next.findIndex((t) => t.id === targetId);
  next.splice(from < to ? insertAt + 1 : insertAt, 0, moved);
  return next;
}
