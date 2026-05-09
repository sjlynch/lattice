import { useEffect, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../../../api';

type DragRect = { x1: number; y1: number; x2: number; y2: number };

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
    let startX = 0;
    let startY = 0;
    let altAtStart = false;
    let prevRotate: boolean | undefined;
    let prevPan: boolean | undefined;

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

      const rect = container!.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      altAtStart = e.altKey;
      dragging = true;
      activePointerId = e.pointerId;
      setDragRect({ x1: startX, y1: startY, x2: startX, y2: startY });
      closeContextMenu();

      // Belt-and-suspenders: also disable the controls flags. If anything
      // slipped past stopPropagation, OrbitControls will bail in its
      // mouseAction switch instead of starting a pan.
      const ctrl = graphRef.current?.controls() as
        | { enableRotate?: boolean; enablePan?: boolean }
        | undefined;
      if (ctrl) {
        prevRotate = ctrl.enableRotate;
        prevPan = ctrl.enablePan;
        ctrl.enableRotate = false;
        ctrl.enablePan = false;
      }
      e.preventDefault();
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging || e.pointerId !== activePointerId) return;
      const rect = container!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDragRect({ x1: startX, y1: startY, x2: x, y2: y });
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragging || e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;

      const rect = container!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const finalRect = {
        x1: Math.min(startX, x),
        y1: Math.min(startY, y),
        x2: Math.max(startX, x),
        y2: Math.max(startY, y),
      };

      const ctrl = graphRef.current?.controls() as
        | { enableRotate?: boolean; enablePan?: boolean }
        | undefined;
      if (ctrl) {
        if (prevRotate !== undefined) ctrl.enableRotate = prevRotate;
        if (prevPan !== undefined) ctrl.enablePan = prevPan;
      }

      // Treat a tiny drag as a "click" — clear selection and bail.
      const isClick =
        finalRect.x2 - finalRect.x1 < 4 && finalRect.y2 - finalRect.y1 < 4;
      if (isClick) {
        setSelected(new Set());
        setDragRect(null);
        return;
      }

      const graph = graphRef.current;
      if (graph) {
        const camera = graph.camera() as THREE.Camera;
        const W = container!.clientWidth;
        const H = container!.clientHeight;
        const includeDirs = altAtStart;
        const next = new Set<string>();
        const v = new THREE.Vector3();
        const nodes = graph.graphData().nodes as Array<
          GraphNode & { x?: number; y?: number; z?: number }
        >;
        for (const node of nodes) {
          if (!includeDirs && node.kind === 'dir') continue;
          if (node.kind === 'file') {
            const key = node.ext ? node.ext.toLowerCase() : '*';
            if (hiddenExtsRef.current.has(key)) continue;
          }
          if (node.x == null || node.y == null || node.z == null) continue;
          v.set(node.x, node.y, node.z).project(camera);
          // Behind the camera or beyond the far plane — skip.
          if (v.z < -1 || v.z > 1) continue;
          const sx = (v.x * 0.5 + 0.5) * W;
          const sy = (-v.y * 0.5 + 0.5) * H;
          if (
            sx >= finalRect.x1 &&
            sx <= finalRect.x2 &&
            sy >= finalRect.y1 &&
            sy <= finalRect.y2
          ) {
            next.add(node.id);
          }
        }
        setSelected(next);
      }
      setDragRect(null);
    }

    container.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [containerRef, graphRef, hiddenExtsRef, setSelected, closeContextMenu]);

  return { dragRect };
}
