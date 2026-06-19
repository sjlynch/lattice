// Hover tooltip shown on the graph view when the cursor is over a file
// node with health metrics. The tooltip owns its own cursor tracking:
// it reads the cached cursor position on mount, then subscribes to
// `pointermove` and writes directly to its element's `transform` —
// re-rendering the React tree per pixel was previously the second
// biggest source of idle CPU after the perpetual 3D render loop.
//
// Returning null when `healthDetails` is missing keeps the tooltip safe
// even though `onNodeHover` no longer pre-filters on that field (the
// pre-filter was racing with `graph.refresh()` while the user was
// holding `h`, dropping legitimate hovers).

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { GraphNode } from '../../api';
import { getLastCursor } from './cursorTracker';
import { healthColor } from './healthOverlay';
import {
  ESTIMATED_HEIGHT,
  TOOLTIP_WIDTH,
  clampPosition,
  type TooltipPosition,
} from './tooltipPosition';
import { buildHealthMetricRows } from './healthTooltipMetrics';
import {
  HealthTooltipHeader,
  MetricGrid,
  SmellList,
} from './HealthTooltipSections';

type Props = {
  node: GraphNode;
};

export function HealthTooltip({ node }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Height is measured once per commit (and so re-measured on a content/node
  // change) and cached here, so the hot per-pointer placement path never
  // reads layout (`offsetHeight`) again.
  const heightRef = useRef(ESTIMATED_HEIGHT);
  // Last clamped position actually written to `transform`; lets us skip the
  // write entirely when a pointer move doesn't change the clamped placement.
  const lastPosRef = useRef<TooltipPosition | null>(null);
  // RAF coalescing for pointer-driven placement: keep the latest cursor and
  // flush at most one transform write per frame.
  const pendingRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  const place = useCallback((clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const pos = clampPosition(clientX, clientY, TOOLTIP_WIDTH, heightRef.current);
    const last = lastPosRef.current;
    if (last && last.left === pos.left && last.top === pos.top) return;
    lastPosRef.current = pos;
    // translate3d so the position update stays on the compositor and
    // never invalidates layout for the rest of the page.
    el.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
    // Reveal only once positioned so the first paint never shows the
    // tooltip at (0,0) before this fires.
    el.style.visibility = 'visible';
  }, []);

  useLayoutEffect(() => {
    // The element starts hidden until we have cursor coordinates. Same-file
    // hover refreshes and overlay-mode renders (for example when `h`
    // toggles) don't necessarily change `node.path`, so a dependency-limited
    // effect can miss the placement/reveal pass. Re-measure + re-place/reveal
    // after every commit; this is one layout read plus (at most) one transform
    // write per commit — the per-pointer path below never touches layout.
    const el = ref.current;
    if (!el) return;
    heightRef.current = el.offsetHeight || ESTIMATED_HEIGHT;
    const cached = getLastCursor();
    if (cached) place(cached.clientX, cached.clientY);
  });

  useLayoutEffect(() => {
    const flush = () => {
      rafRef.current = null;
      const p = pendingRef.current;
      if (p) place(p.x, p.y);
    };
    const onMove = (ev: PointerEvent) => {
      pendingRef.current = { x: ev.clientX, y: ev.clientY };
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [place]);

  const m = node.healthDetails;
  if (!m) return null;

  const color = healthColor(m.score);
  const metricRows = buildHealthMetricRows(m);

  return (
    <div
      ref={ref}
      className="health-tooltip"
      // `left`/`top` are zeroed; positioning lives in `transform` so we
      // can update it from the imperative pointermove handler above
      // without touching React state. `visibility: hidden` prevents the
      // (0,0) flash before useLayoutEffect places + reveals.
      style={{
        left: 0,
        top: 0,
        width: TOOLTIP_WIDTH,
        visibility: 'hidden',
      }}
    >
      <HealthTooltipHeader node={node} metrics={m} color={color} />
      <MetricGrid rows={metricRows} />
      <SmellList smells={m.smells} smellCount={m.smellCount} />
    </div>
  );
}

export type { HealthSmell } from '../../api';
