import { useEffect, useState, type MutableRefObject } from 'react';

// Right-click anywhere over the graph viewport opens our popover.
// Coords are stored relative to the container because the popover is
// rendered inside the (position: relative) wrapper and `.popover` falls
// back to position: absolute, so viewport coords would land offset by
// the sidebar/topbar.
//
// Right-drag pans the camera (OrbitControls); the browser still fires
// `contextmenu` on release, and we want the menu only on a real click.
// The two reliable pieces:
//
//   1. mousedown/mouseup positions captured at window level in capture
//      phase. mousedown/mouseup are compat events that fire for
//      pointerType=mouse regardless of pointer preventDefault, and
//      window-capture beats anything inside the canvas tree to the
//      event. Compare the two at contextmenu time; if the cursor moved
//      more than DRAG_THRESHOLD between them, it was a pan.
//
//   2. The contextmenu handler also lives on window (capture), gated
//      on containerRef.current.contains(e.target). A previous version
//      attached it to the container; cleanup used
//      `containerRef.current?.removeEventListener(...)`, and the
//      optional chaining silently no-op'd across React StrictMode's
//      mount/cleanup/remount cycle, leaking an old closure with a
//      stale rightUpAt that opened the menu after every right-drag.
export function useNodeContextMenu(
  containerRef: MutableRefObject<HTMLDivElement | null>,
) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const DRAG_THRESHOLD = 5;
    let rightDownX = 0;
    let rightDownY = 0;
    let rightUpX = 0;
    let rightUpY = 0;
    let rightUpAt = 0;
    const onMouseDownWin = (e: MouseEvent) => {
      if (e.button !== 2) return;
      rightDownX = e.clientX;
      rightDownY = e.clientY;
    };
    const onMouseUpWin = (e: MouseEvent) => {
      if (e.button !== 2) return;
      rightUpX = e.clientX;
      rightUpY = e.clientY;
      rightUpAt = performance.now();
    };
    const onCtxMenu = (e: MouseEvent) => {
      const container = containerRef.current;
      const target = e.target as Node | null;
      if (!container || !target || !container.contains(target)) return;
      e.preventDefault();
      // Recency check so keyboard contextmenu (Shift+F10, menu key) — which
      // has no paired mouseup — still opens the menu.
      if (performance.now() - rightUpAt < 500) {
        const dx = rightUpX - rightDownX;
        const dy = rightUpY - rightDownY;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      }
      const rect = container.getBoundingClientRect();
      setContextMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    window.addEventListener('mousedown', onMouseDownWin, { capture: true });
    window.addEventListener('mouseup', onMouseUpWin, { capture: true });
    window.addEventListener('contextmenu', onCtxMenu, { capture: true });
    return () => {
      window.removeEventListener('mousedown', onMouseDownWin, { capture: true });
      window.removeEventListener('mouseup', onMouseUpWin, { capture: true });
      window.removeEventListener('contextmenu', onCtxMenu, { capture: true });
    };
  }, [containerRef]);

  // Close the context menu when clicking outside it.
  useEffect(() => {
    if (!contextMenu) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.graph-context-menu')) return;
      setContextMenu(null);
    }
    // Defer attachment so the same right-click that opened the menu doesn't
    // immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onDown);
    };
  }, [contextMenu]);

  return { contextMenu, setContextMenu };
}
