import { useEffect, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { Camera } from 'three';
import {
  isTinyDrag,
  normalizeDragRect,
  selectNodesInRect,
  type DragRect,
  type PositionedGraphNode,
  type ScreenPoint,
} from './boxSelectGeometry';
import {
  disableOrbitControls,
  type OrbitControlsLock,
  type OrbitControlsLockTarget,
} from './orbitControlLock';

// Shift-drag a rectangle over the viewport to select every visible
// file node whose projected screen position lands inside it. Alt
// while starting the drag also includes directories.
//
// The first half of the listener wiring (capture-phase pointerdown +
// disabling OrbitControls flags) is what makes this work alongside
// the camera controls — see the inline comments inside the effect.
export function useBoxSelect(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  hiddenExtsRef: MutableRefObject<Set<string>>,
  setSelected: (next: Set<string>) => void,
  closeContextMenu: () => void,
) {
  const [dragRect, setDragRect] = useState<DragRect | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let dragging = false;
    let activePointerId: number | null = null;
    let start: ScreenPoint = { x: 0, y: 0 };
    let altAtStart = false;
    let controlsLock: OrbitControlsLock | null = null;

    // RAF-coalesce the drag-rect overlay: a fast pointermove fires far more
    // often than the display refreshes, so we keep the latest pointer
    // position and flush at most one `setDragRect` per frame instead of one
    // per raw event. The final selection still uses the pointerup position
    // directly (below), so coalescing never changes what gets selected.
    let pendingPoint: ScreenPoint | null = null;
    let rafId: number | null = null;

    function pointerPoint(e: PointerEvent): ScreenPoint {
      const rect = container!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function cancelScheduledRect() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingPoint = null;
    }

    function flushDragRect() {
      rafId = null;
      if (!dragging || !pendingPoint) return;
      setDragRect({ x1: start.x, y1: start.y, x2: pendingPoint.x, y2: pendingPoint.y });
    }

    function restoreControls() {
      controlsLock?.restore();
      controlsLock = null;
    }

    // Capture phase + pointerdown so we run before OrbitControls' canvas-level
    // pointerdown listener. Without this, shift+left-click immediately
    // transitions OrbitControls into PAN state, and toggling enablePan
    // afterward has no effect for the active gesture — the camera pans
    // through the whole drag and the box-select rect tracks a moving world.
    //
    // We use pointer events for the whole gesture (down/move/up). preventDefault
    // on pointerdown suppresses the matching compat mousemove/mouseup, so a
    // mixed pointer/mouse handler set would never see the rest of the drag.
    function onPointerDown(e: PointerEvent) {
      if (!e.shiftKey || e.button !== 0) return;
      // Stop OrbitControls and 3d-force-graph's own listeners from seeing
      // this event at all.
      e.stopPropagation();
      e.stopImmediatePropagation();

      start = pointerPoint(e);
      altAtStart = e.altKey;
      dragging = true;
      activePointerId = e.pointerId;
      setDragRect({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
      closeContextMenu();

      // Belt-and-suspenders: also disable the controls flags. If anything
      // slipped past stopPropagation, OrbitControls will bail in its
      // mouseAction switch instead of starting a pan.
      controlsLock = disableOrbitControls(
        graphRef.current?.controls() as OrbitControlsLockTarget | undefined,
      );
      e.preventDefault();
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging || e.pointerId !== activePointerId) return;
      pendingPoint = pointerPoint(e);
      if (rafId === null) rafId = requestAnimationFrame(flushDragRect);
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragging || e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      cancelScheduledRect();

      const point = pointerPoint(e);
      const finalRect = normalizeDragRect(start, point);
      restoreControls();

      // Treat a tiny drag as a "click" — clear selection and bail.
      if (isTinyDrag(finalRect)) {
        setSelected(new Set());
        setDragRect(null);
        return;
      }

      const graph = graphRef.current;
      if (graph) {
        const camera = graph.camera() as Camera;
        const nodes = graph.graphData().nodes as PositionedGraphNode[];
        setSelected(
          selectNodesInRect(nodes, {
            rect: finalRect,
            camera,
            viewport: { width: container!.clientWidth, height: container!.clientHeight },
            includeDirs: altAtStart,
            hiddenExts: hiddenExtsRef.current,
          }),
        );
      }
      setDragRect(null);
    }

    container.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      cancelScheduledRect();
      restoreControls();
      container.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [containerRef, graphRef, hiddenExtsRef, setSelected, closeContextMenu]);

  return { dragRect };
}
