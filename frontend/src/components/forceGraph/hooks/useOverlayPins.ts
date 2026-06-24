import { useCallback, useState } from 'react';

// The five momentary hold-key graph overlays, by stable key. Each is normally
// active only while its key is held (H health, Z lines-of-code, D dead-code, W
// worktree-modified, Alt name labels); a "pin" latches that same state on so the
// view persists without holding the key. The chips in `GraphOverlayKey` toggle
// these pins, and each overlay hook folds its pin into its effective mode
// (`held || pinned`) — so pinning reuses the exact activation path the hold-key
// already drives.
export type OverlayPinKey = 'health' | 'loc' | 'dead' | 'worktree' | 'labels';

export type OverlayPins = Record<OverlayPinKey, boolean>;

const NO_PINS: OverlayPins = {
  health: false,
  loc: false,
  dead: false,
  worktree: false,
  labels: false,
};

// Pin state for the graph's hold-key overlays. Pins are independent toggles —
// any overlap between simultaneously-pinned views is governed by the same
// sprite-recolor precedence the hold-keys already use (health > loc > dead),
// exactly as if the keys were held together. Kept in component state (not
// persisted): a pin survives the key release, not a reload.
export function useOverlayPins() {
  const [pinned, setPinned] = useState<OverlayPins>(NO_PINS);
  const togglePin = useCallback((key: OverlayPinKey) => {
    setPinned((cur) => ({ ...cur, [key]: !cur[key] }));
  }, []);
  return { pinned, togglePin };
}
