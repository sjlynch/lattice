// Pure sidebar-panel logic. Kept React-free (no hooks/xterm imports) so it
// stays trivially unit-testable — `usePanelState` is just the React wiring
// around these.
import type { TerminalSpec } from '../../../terminal/terminalTypes';

export type Panel = 'terminals' | 'merging' | 'startup';

// The panel a terminal of the given kind lives in.
export function panelForKind(kind: TerminalSpec['kind']): Panel {
  return kind === 'merge' ? 'merging' : kind === 'startup' ? 'startup' : 'terminals';
}

// Whether the currently-viewed Merging/Startup panel has just emptied, so we
// must auto-fall-back to the Terminals panel. This auto-switch bypasses
// Sidebar's `switchPanel` wrapper, so the search filter must be reset
// separately (see Sidebar's activePanel-keyed effect) — a stale query would
// otherwise hide the Terminals panel's terminals.
export function shouldFallBackToTerminals(
  activePanel: Panel,
  mergeCount: number,
  startupCount: number,
): boolean {
  return (
    (mergeCount === 0 && activePanel === 'merging') ||
    (startupCount === 0 && activePanel === 'startup')
  );
}
