// Single always-on `pointermove` listener that caches the most recent
// viewport-space cursor coordinates. The graph's HealthTooltip reads from
// this on mount so it can render at the cursor immediately, then
// subscribes to live updates via its own `pointermove` listener (which
// writes directly to the tooltip element's transform, skipping React
// state entirely).
//
// Storing two numbers in a module variable is essentially free; the prior
// `useHoverCursor` re-rendered the whole graph subtree on every move.

export type CursorPos = { clientX: number; clientY: number };

let last: CursorPos | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (ev: PointerEvent) => {
      last = { clientX: ev.clientX, clientY: ev.clientY };
    },
    { passive: true, capture: true },
  );
}

export function getLastCursor(): CursorPos | null {
  return last;
}
