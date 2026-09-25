import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { flushSync } from 'react-dom';
import type { GraphNode } from '../../../api';

// When labels are dense or still moving the raycaster can blip in and
// out of label hitboxes every other frame, firing `(file, null, file,
// null, …)`. Each null transition would unmount HealthTooltip and a
// fresh mount restarts the opacity fade-in from zero — if the flicker
// is faster than ~80 ms the tooltip is invisible at all times. Debounce
// null transitions so a fresh hover within the window cancels the
// pending unmount; the user only loses the tooltip if their cursor is
// genuinely off all labels for longer than NULL_HOVER_DEBOUNCE_MS.
const NULL_HOVER_DEBOUNCE_MS = 220;

// Owns the file-hover state for the HUD tooltip and the debounce that
// keeps it from flickering out between adjacent label hitboxes.
// `pointerDraggingRef` is read (not owned) so hover is ignored entirely
// while a canvas drag is in progress; the drag tracker drives that ref
// and calls `cancelPendingHoverClear` at drag start to hide any open
// tooltip. `pointerOutsideRef` (driven by `usePointerLeaveTooltipDismiss`) is
// read the same way: while the cursor is off the canvas the library can still
// raycast its last on-canvas position, so a hover-in then is stale and dropped.
// Returns the debounced setter wired into the graph's `onHover`.
export function useHoverNodeDebounce(
  pointerDraggingRef: MutableRefObject<boolean>,
  pointerOutsideRef: MutableRefObject<boolean>,
) {
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
  const nullClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedSetHoverNode = useCallback(
    (node: GraphNode | null) => {
      // While dragging, ignore hover entirely. The tooltip is cleared at drag
      // start and the library re-fires hover on the first move after release.
      if (pointerDraggingRef.current) return;
      if (node !== null) {
        if (pointerOutsideRef.current) return;
        if (nullClearTimerRef.current) {
          clearTimeout(nullClearTimerRef.current);
          nullClearTimerRef.current = null;
        }
        // 3d-force-graph emits hover changes from its RAF, outside
        // React's event system. While the health overlay is also running
        // RAF work, normal-priority commits can be delayed until the user
        // releases `h`, which made the tooltip appear only as the mode was
        // turning off. Hover-in changes are infrequent (raycast-throttled),
        // so flush this small state update synchronously.
        flushSync(() => setHoverNode(node));
        return;
      }
      if (nullClearTimerRef.current) return;
      nullClearTimerRef.current = setTimeout(() => {
        nullClearTimerRef.current = null;
        setHoverNode(null);
      }, NULL_HOVER_DEBOUNCE_MS);
    },
    [pointerDraggingRef, pointerOutsideRef],
  );

  // Cancel a pending hover-clear and hide any open tooltip. Called at drag
  // start so a stale tooltip doesn't sit over the rotating graph; the
  // functional updater skips the render when nothing was shown.
  const cancelPendingHoverClear = useCallback(() => {
    if (nullClearTimerRef.current) {
      clearTimeout(nullClearTimerRef.current);
      nullClearTimerRef.current = null;
    }
    setHoverNode((cur) => (cur === null ? cur : null));
  }, []);

  useEffect(() => {
    return () => {
      if (nullClearTimerRef.current) clearTimeout(nullClearTimerRef.current);
    };
  }, []);

  return { hoverNode, debouncedSetHoverNode, cancelPendingHoverClear };
}
