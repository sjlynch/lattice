import { useEffect, useState, type MutableRefObject } from 'react';

// Track viewport-space cursor coordinates whenever the cursor is
// over the graph container. The HealthTooltip uses position: fixed
// (viewport coords) so we pass clientX/clientY through unchanged.
// We track unconditionally — the tooltip itself only renders when a
// file node is hovered AND has health data, so the listener is
// cheap when nothing's hovered.
export function useHoverCursor(
  containerRef: MutableRefObject<HTMLDivElement | null>,
) {
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function onMove(ev: MouseEvent) {
      setHoverPos({ x: ev.clientX, y: ev.clientY });
    }
    function onLeave() {
      // Drop the tracked position when the cursor leaves the graph
      // viewport so a stale tooltip doesn't linger if onNodeHover
      // doesn't fire its `null` event for some reason.
      setHoverPos(null);
    }
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, [containerRef]);

  return { hoverPos };
}
