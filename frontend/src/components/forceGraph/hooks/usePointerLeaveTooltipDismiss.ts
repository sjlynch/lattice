import { useEffect, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';

// Hide graph node tooltips as soon as the cursor leaves the graph canvas — onto
// the navbar, the terminal panel, a HUD panel floating over the graph, or out of
// the window entirely.
//
// Why they stuck: 3d-force-graph only re-evaluates hover by raycasting its last
// recorded pointer position inside its render loop, and it records that
// position only from `pointermove` events ON its container. Once the cursor
// leaves, the recorded position stays frozen on the node it last touched, so the
// library never reports "no longer hovering" — the React HealthTooltip (which
// tracks the cursor itself via a window listener) followed the cursor across the
// rest of the app, and the library's own native label (folders / deleted files)
// stayed parked over the canvas.
//
// On leave we: mark the pointer outside (the hover setter and the native-label
// accessor both read `pointerOutsideRef`, so a raycast that still runs against
// the stale position — e.g. `clearLabelsAndRefresh` re-enabling interaction —
// can't bring a tooltip back); clear the React tooltip immediately (skipping the
// null-hover debounce); and suspend the library's pointer interaction, whose
// onChange resets its cached hover object and hides the native label, and which
// stops the per-frame raycast while nothing can be hovered. On re-entry we
// re-enable it — the reset hover object means a node under the entry point
// fires `onNodeHover` again. Mid-drag the drag tracker owns interaction (it
// disables it for the gesture and re-enables on release), so we leave it be.
export type PointerLeaveTooltipDismissOptions = {
  pointerOutsideRef: MutableRefObject<boolean>;
  pointerDraggingRef: MutableRefObject<boolean>;
  clearHoverTooltip: () => void;
  setPointerInteraction: (on: boolean) => void;
};

export function attachPointerLeaveTooltipDismiss(
  container: EventTarget,
  {
    pointerOutsideRef,
    pointerDraggingRef,
    clearHoverTooltip,
    setPointerInteraction,
  }: PointerLeaveTooltipDismissOptions,
): () => void {
  const onLeave = () => {
    pointerOutsideRef.current = true;
    clearHoverTooltip();
    if (!pointerDraggingRef.current) setPointerInteraction(false);
  };
  const onEnter = () => {
    if (!pointerOutsideRef.current) return;
    pointerOutsideRef.current = false;
    if (!pointerDraggingRef.current) setPointerInteraction(true);
  };
  container.addEventListener('pointerleave', onLeave);
  container.addEventListener('pointerenter', onEnter);
  return () => {
    container.removeEventListener('pointerleave', onLeave);
    container.removeEventListener('pointerenter', onEnter);
    // Don't leave interaction disabled if we unmount while the cursor is out.
    if (pointerOutsideRef.current && !pointerDraggingRef.current) {
      setPointerInteraction(true);
    }
    pointerOutsideRef.current = false;
  };
}

export function usePointerLeaveTooltipDismiss(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  pointerOutsideRef: MutableRefObject<boolean>,
  pointerDraggingRef: MutableRefObject<boolean>,
  clearHoverTooltip: () => void,
) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return attachPointerLeaveTooltipDismiss(el, {
      pointerOutsideRef,
      pointerDraggingRef,
      clearHoverTooltip,
      setPointerInteraction: (on) => {
        const g = graphRef.current as unknown as {
          enablePointerInteraction?: (v: boolean) => unknown;
        } | null;
        g?.enablePointerInteraction?.(on);
      },
    });
  }, [containerRef, graphRef, pointerOutsideRef, pointerDraggingRef, clearHoverTooltip]);
}
