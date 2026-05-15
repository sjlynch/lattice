// Hover tooltip shown on the graph view when the cursor is over a
// file node. Renders the file's overall health score, a per-metric
// breakdown, and a list of detected smells with their counts.
//
// Positioning uses `position: fixed` (viewport coords) and a
// useLayoutEffect-measured rect so we can clamp the tooltip inside
// the viewport without ever clipping it. Default placement is to the
// right of the cursor; if that would overflow we flip left, then if
// neither fits we anchor to the closest edge. Vertically we anchor to
// the top of the viewport when the tooltip is taller than the space
// below the cursor.

import { useLayoutEffect, useRef, useState } from 'react';
import type { GraphNode } from '../../api';
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
  // Cursor coords are in viewport space (event.clientX/clientY).
  node: GraphNode;
  x: number;
  y: number;
};

export function HealthTooltip({ node, x, y }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Cache the measured height across cursor moves so we re-position
  // smoothly without remeasuring every frame. The height only changes
  // when the hovered NODE changes (different smells / metrics fill in
  // a different number of rows) — so we re-measure on node identity.
  const [measuredHeight, setMeasuredHeight] = useState(ESTIMATED_HEIGHT);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0 && h !== measuredHeight) setMeasuredHeight(h);
    // Re-measure when the hovered file's content changes; cursor
    // movement alone doesn't need a new measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.path, node.healthDetails?.smellCount]);

  const m = node.healthDetails;
  if (!m) return null;

  const color = healthColor(m.score);
  const pos = clampPosition(x, y, TOOLTIP_WIDTH, measuredHeight);
  const metricRows = buildHealthMetricRows(m);

  return (
    <div
      ref={ref}
      className="health-tooltip"
      style={{ left: pos.left, top: pos.top, width: TOOLTIP_WIDTH }}
    >
      <HealthTooltipHeader node={node} metrics={m} color={color} />
      <MetricGrid rows={metricRows} />
      <SmellList smells={m.smells} smellCount={m.smellCount} />
    </div>
  );
}

export type { HealthSmell } from '../../api';
