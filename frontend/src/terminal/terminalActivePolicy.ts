import { normalizeDirPath } from './terminalScope';
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

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return normalizeDirPath(a) === normalizeDirPath(b);
}

function isSameFallbackGroup(
  terminal: TerminalSpec,
  target: TerminalSpec,
): boolean {
  // Normalized, like `terminalBelongsToProject`: registry tabs carry the
  // backend's realpath spelling of the project, locally-created fallback tabs
  // the frontend's, and both are listed in the same panel. A strict compare
  // left the panel empty-selected after closing the active tab of one spelling.
  return (
    terminalPanelKind(terminal) === terminalPanelKind(target) &&
    samePath(terminal.projectPath, target.projectPath)
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

// The active tab vanished from the project's list. Two ways that happens:
//  - it was removed while this project stayed open — usually the registry's
//    `ended` event for a close landing before the DELETE response, so
//    `closeTerminal`'s own fallback hasn't run yet. Use the same in-panel
//    neighbour policy; picking "the last project tab" here jumped focus to a
//    Startup terminal.
//  - the project switched: prefer a regular (agent/shell) tab, falling back to
//    a Startup/Merging one only when the project has no regular tab at all.
export function pickActiveAfterDisappear(
  prevProjectList: TerminalSpec[],
  nextProjectList: TerminalSpec[],
  missingId: string,
  sameProject: boolean,
): string | null {
  if (sameProject && prevProjectList.some((t) => t.id === missingId)) {
    return pickActiveAfterClose(prevProjectList, nextProjectList, missingId, missingId);
  }
  const regular = nextProjectList.filter((t) => terminalPanelKind(t) === 'regular');
  return (regular.at(-1) ?? nextProjectList.at(-1))?.id ?? null;
}
