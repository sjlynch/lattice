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

import { useLayoutEffect, useRef } from 'react';
import type { GraphNode } from '../../api';
import { getLastCursor } from './cursorTracker';
import { healthColor } from './healthOverlay';
import {
  ESTIMATED_HEIGHT,
  TOOLTIP_WIDTH,
  clampPosition,
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

function placeTooltip(el: HTMLDivElement, clientX: number, clientY: number) {
  const measuredHeight = el.offsetHeight || ESTIMATED_HEIGHT;
  const pos = clampPosition(clientX, clientY, TOOLTIP_WIDTH, measuredHeight);
  // translate3d so the position update stays on the compositor and
  // never invalidates layout for the rest of the page.
  el.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
  // Reveal only once positioned so the first paint never shows the
  // tooltip at (0,0) before the layout effect fires.
  el.style.visibility = 'visible';
}

export function HealthTooltip({ node }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // The element starts hidden until we have cursor coordinates. Same-file
    // hover refreshes and overlay-mode renders (for example when `h`
    // toggles) don't necessarily change `node.path`, so a dependency-limited
    // effect can miss the placement/reveal pass. Re-place/reveal after every
    // commit; this is just one cached cursor read plus a transform write.
    const el = ref.current;
    const cached = getLastCursor();
    if (el && cached) placeTooltip(el, cached.clientX, cached.clientY);
  });

  useLayoutEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const el = ref.current;
      if (el) placeTooltip(el, ev.clientX, ev.clientY);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

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
