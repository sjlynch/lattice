import { useEffect, useRef } from 'react';

// Dismiss a stuck hover tooltip when an LOC/health overlay view *ends*.
//
// The bug: 3d-force-graph only re-evaluates hover by raycasting inside its
// render loop. While `z`/`h` is held the loop runs continuously (the overlay's
// label-physics reason keeps it awake), so hover tracks normally. The instant
// the key is released the overlay toggles off, the loop settles and pauses, and
// the library's cached hover object is reset by the toggle's
// `clearLabelsAndRefresh` (enablePointerInteraction off/on). Because that reset
// leaves the React `hoverNode` set while the library's hover object is now null,
// a subsequent "cursor no longer over a node" produces a null-vs-null compare
// that never fires `onNodeHover(null)` — so the tooltip sticks to the cursor
// (following it via its own pointermove listener) until the overlay is
// re-entered.
//
// Fix: when the last active overlay view (LOC or health) turns off, clear the
// hover tooltip. The overlay-toggle's `clearLabelsAndRefresh` resets the
// library's hover object in the same commit, so the very next render frame
// re-fires `onNodeHover` and restores the tooltip iff the cursor is genuinely
// still over a node — preserving normal hover/mouseout behavior while killing
// the stale stick. Only the active→inactive transition clears (entering an
// overlay must not dismiss a legitimately-hovered tooltip).
export function useOverlayTooltipDismiss(
  locMode: boolean,
  healthMode: boolean,
  clearHoverTooltip: () => void,
): void {
  const prevActiveRef = useRef(false);
  useEffect(() => {
    const active = locMode || healthMode;
    if (prevActiveRef.current && !active) clearHoverTooltip();
    prevActiveRef.current = active;
  }, [locMode, healthMode, clearHoverTooltip]);
}
