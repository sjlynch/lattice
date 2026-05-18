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

export function HealthTooltip({ node }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // eslint-disable-next-line no-console
    console.debug('[lattice/graph] HealthTooltip mount/update:', node.name, {
      hasHealthDetails: node.healthDetails != null,
    });

    function place(clientX: number, clientY: number) {
      if (!el) return;
      const measuredHeight = el.offsetHeight || ESTIMATED_HEIGHT;
      const pos = clampPosition(clientX, clientY, TOOLTIP_WIDTH, measuredHeight);
      // translate3d so the position update stays on the compositor and
      // never invalidates layout for the rest of the page.
      el.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
      // Reveal only once positioned so the first paint never shows the
      // tooltip at (0,0) before the layout effect fires.
      el.style.visibility = 'visible';
    }

    // Initial placement: use the last cached cursor so the tooltip
    // appears at the cursor even if the user hasn't moved since the
    // hover started.
    const cached = getLastCursor();
    if (cached) {
      place(cached.clientX, cached.clientY);
    }
    // If no cursor was seen yet, leave the tooltip `visibility: hidden`
    // (its inline style on the JSX element below). The first pointermove
    // will reveal it via `place()`.

    const onMove = (ev: PointerEvent) => place(ev.clientX, ev.clientY);
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [node.path, node.healthDetails?.smellCount]);

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
