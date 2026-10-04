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
// OrbitControls are unaffected. Re-enabled on release. Wait for pointer movement:
// disabling it on pointerdown clears the library's picked node and loses clicks.
export function attachCanvasDragTracking(
  container: EventTarget,
  releaseTarget: EventTarget,
  pointerDraggingRef: MutableRefObject<boolean>,
  onDragStart: () => void,
  setPointerInteraction: (on: boolean) => void,
): () => void {
  let origin: { x: number; y: number; pointerId: number } | null = null;
  let suspended = false;
  const onDown = (event: Event) => {
    const e = event as PointerEvent;
    if (origin) return;
    origin = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    pointerDraggingRef.current = true;
    onDragStart();
  };
  const onMove = (event: Event) => {
    const e = event as PointerEvent;
    if (!origin || suspended || e.pointerId !== origin.pointerId) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 4) return;
    suspended = true;
    setPointerInteraction(false);
  };
  const onUp = (event: Event) => {
    if (!origin || (event as PointerEvent).pointerId !== origin.pointerId) return;
    origin = null;
    pointerDraggingRef.current = false;
    // Even setting true when already enabled clears the library's hoverObj.
    if (suspended) setPointerInteraction(true);
    suspended = false;
  };
  container.addEventListener('pointerdown', onDown, { passive: true });
  releaseTarget.addEventListener('pointermove', onMove, { passive: true });
  releaseTarget.addEventListener('pointerup', onUp, { passive: true });
  releaseTarget.addEventListener('pointercancel', onUp, { passive: true });
  return () => {
    container.removeEventListener('pointerdown', onDown);
    releaseTarget.removeEventListener('pointermove', onMove);
    releaseTarget.removeEventListener('pointerup', onUp);
    releaseTarget.removeEventListener('pointercancel', onUp);
    if (suspended) setPointerInteraction(true);
    pointerDraggingRef.current = false;
    origin = null;
  };
}

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
    return attachCanvasDragTracking(el, window, pointerDraggingRef, onDragStart, setPointerInteraction);
  }, [containerRef, graphRef, pointerDraggingRef, onDragStart]);
}
