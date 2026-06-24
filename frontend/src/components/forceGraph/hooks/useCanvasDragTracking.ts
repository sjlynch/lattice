import { useEffect, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';

// Track pointer-drag state on the canvas to gate hover (the debounced hover
// setter reads `pointerDraggingRef`). pointerdown on the container starts a
// drag; the release is bound on `window` because a fast rotate often lifts
// off-canvas. At drag start `onDragStart` cancels any pending hover-clear and
// hides an open tooltip so it doesn't sit stale over the rotating graph.
//
// We ALSO suspend 3d-force-graph's pointer interaction for the gesture
// (`enablePointerInteraction(false)`). The library re-runs an O(N) hover
// raycast — over every node incl. the invisible batched-node pick proxies —
// on EVERY render frame (`renderObjs.tick`), and on a hover change it shows /
// positions its own DOM tooltip element (the `Recalculate style` / `setProperty`
// / `Layerize` churn in the trace). None of that is wanted while you rotate, so
// disabling it for the drag removes the per-frame raycast + tooltip work. It
// only gates hover/click; the already-constructed node-drag DragControls and
// OrbitControls are unaffected. Re-enabled on release.
export function useCanvasDragTracking(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  pointerDraggingRef: MutableRefObject<boolean>,
  onDragStart: () => void,
) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const setPointerInteraction = (on: boolean) => {
      const g = graphRef.current as unknown as {
        enablePointerInteraction?: (v: boolean) => unknown;
      } | null;
      g?.enablePointerInteraction?.(on);
    };
    const onDown = () => {
      pointerDraggingRef.current = true;
      onDragStart();
      setPointerInteraction(false);
    };
    const onUp = () => {
      if (!pointerDraggingRef.current) return;
      pointerDraggingRef.current = false;
      setPointerInteraction(true);
    };
    el.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      // Don't leave interaction disabled if we unmount mid-drag.
      if (pointerDraggingRef.current) setPointerInteraction(true);
    };
  }, [containerRef, graphRef, pointerDraggingRef, onDragStart]);
}
