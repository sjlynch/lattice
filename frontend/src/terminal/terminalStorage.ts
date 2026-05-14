import type { Persisted, TerminalSpec } from './terminalTypes';

// Stored in sessionStorage (not localStorage) so each browser tab keeps its
// own terminal list. Two tabs sharing one localStorage list would race each
// other on every write — last-writer-wins clobbers the other tab's terminals.
// sessionStorage survives reloads in the same tab but is per-tab, which is
// exactly the isolation we want when users open multiple Lattice tabs on
// different active folders.
export const STORAGE_KEY = 'lattice.terminals';

export function loadPersisted(): Persisted {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { terminals: [], activeId: null };
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || !Array.isArray(parsed.terminals)) {
      return { terminals: [], activeId: null };
    }
    return {
      terminals: parsed.terminals.filter(
        (t): t is TerminalSpec =>
          !!t && typeof t.id === 'string' && typeof t.cwd === 'string',
      ),
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
    };
  } catch {
    return { terminals: [], activeId: null };
  }
}

export function persist(state: Persisted): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode — ignore */
  }
}
