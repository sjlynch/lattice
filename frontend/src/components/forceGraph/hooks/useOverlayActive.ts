import { useMemo } from 'react';
import type { OverlayPins } from './useOverlayPins';

// Which overlay views are currently *showing* (held OR pinned), for the
// overlay-key chips' lit "active" state. `healthMode` is the App-owned
// effective value (already composed in `useHealthOverlay`); the rest come back
// from `useGraphOverlays` / `useWorktreeHighlight` already folded with their
// pins. Shares `OverlayPins`' shape so it drops straight into the
// `GraphOverlayKey` `active` prop, and is memoised so that prop is stable.
export function useOverlayActive(modes: {
  health: boolean;
  loc: boolean;
  dead: boolean;
  worktree: boolean;
  labels: boolean;
}): OverlayPins {
  const { health, loc, dead, worktree, labels } = modes;
  return useMemo(
    () => ({ health, loc, dead, worktree, labels }),
    [health, loc, dead, worktree, labels],
  );
}
