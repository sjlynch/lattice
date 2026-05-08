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
import type { GraphNode, HealthMetrics, HealthSmell } from '../../api';
import { healthColor } from './healthOverlay';

type Props = {
  // Cursor coords are in viewport space (event.clientX/clientY).
  node: GraphNode;
  x: number;
  y: number;
};

const TOOLTIP_WIDTH = 320;
const CURSOR_OFFSET = 16;
const VIEWPORT_PAD = 12;
// Initial estimate before the tooltip's first paint; refined to the
// actual measured height in the layout effect below.
const ESTIMATED_HEIGHT = 420;

function letterGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function languageLabel(lang: HealthMetrics['language']): string {
  switch (lang) {
    case 'typescript': return 'TypeScript';
    case 'javascript': return 'JavaScript';
    case 'python': return 'Python';
    case 'go': return 'Go';
    case 'rust': return 'Rust';
    case 'java': return 'Java';
    case 'csharp': return 'C#';
    case 'ruby': return 'Ruby';
    case 'fallback': return 'limited analysis';
  }
}

function clampPosition(
  cursorX: number,
  cursorY: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // ---- Horizontal ----
  // Default: right of the cursor with a small offset.
  let left = cursorX + CURSOR_OFFSET;
  if (left + width > vw - VIEWPORT_PAD) {
    // Wouldn't fit on the right — try the left side.
    const leftSide = cursorX - CURSOR_OFFSET - width;
    if (leftSide >= VIEWPORT_PAD) {
      left = leftSide;
    } else {
      // Doesn't fit on either side either; clamp to the right edge.
      left = Math.max(VIEWPORT_PAD, vw - width - VIEWPORT_PAD);
    }
  }

  // ---- Vertical ----
  // Default: a little above the cursor (so the cursor doesn't sit
  // right on the title line).
  let top = cursorY - 8;
  if (top + height > vh - VIEWPORT_PAD) {
    // Would overflow the bottom — anchor the bottom of the tooltip
    // to the bottom of the viewport.
    top = vh - height - VIEWPORT_PAD;
  }
  if (top < VIEWPORT_PAD) top = VIEWPORT_PAD;

  return { left, top };
}

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

  return (
    <div
      ref={ref}
      className="health-tooltip"
      style={{ left: pos.left, top: pos.top, width: TOOLTIP_WIDTH }}
    >
      <div className="health-tooltip-head">
        <span className="health-tooltip-score" style={{ color }}>
          {m.score}
        </span>
        <span className="health-tooltip-grade" style={{ color }}>
          {letterGrade(m.score)}
        </span>
        <div className="health-tooltip-titlewrap">
          <div className="health-tooltip-name" title={node.path}>{node.name}</div>
          <div className="health-tooltip-lang">{languageLabel(m.language)}</div>
        </div>
      </div>

      <div className="health-tooltip-grid">
        <Metric label="LOC" value={m.loc} />
        <Metric
          label="Maintainability"
          value={m.maintainabilityIndex}
          suffix="/100"
        />
        {m.language !== 'fallback' && (
          <>
            <Metric label="Cyclomatic" value={m.cyclomaticMax} suffix="max" />
            <Metric label="Cognitive" value={m.cognitiveMax} suffix="max" />
            <Metric label="Nesting" value={m.maxNestingDepth} suffix="deep" />
            <Metric
              label="Functions"
              value={`${m.namedFunctionCount}`}
              suffix={
                m.functionCount > m.namedFunctionCount
                  ? `(+${m.functionCount - m.namedFunctionCount} anon)`
                  : undefined
              }
            />
            <Metric
              label="Avg fn len"
              value={m.avgFunctionLength > 0 ? Math.round(m.avgFunctionLength) : 0}
            />
            <Metric label="Max fn len" value={m.maxFunctionLength} />
            <Metric label="Max params" value={m.maxParamCount} />
            <Metric label="Classes" value={m.classCount} />
            <Metric
              label="Call density"
              value={m.callGraphDensity.toFixed(2)}
            />
            <Metric
              label="Halstead vol"
              value={m.halstead.volume > 0 ? Math.round(m.halstead.volume) : 0}
            />
          </>
        )}
        <Metric
          label="Comments"
          value={`${Math.round(m.commentRatio * 100)}%`}
        />
        {m.fanIn != null && <Metric label="Fan-in" value={m.fanIn} />}
        {m.fanOut != null && <Metric label="Fan-out" value={m.fanOut} />}
        {m.inCycle && (
          <Metric label="In cycle" value="yes" />
        )}
      </div>

      {m.smells.length > 0 && (
        <div className="health-tooltip-smells">
          <div className="health-tooltip-smells-head">
            Smells · {m.smellCount}
          </div>
          <ul className="health-tooltip-smells-list">
            {m.smells.slice(0, 8).map((s) => (
              <li key={s.id}>
                <span className="health-tooltip-smell-count">{s.count}</span>
                <span className="health-tooltip-smell-label">{s.label}</span>
              </li>
            ))}
            {m.smells.length > 8 && (
              <li className="health-tooltip-smell-more">
                +{m.smells.length - 8} more
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | string;
  suffix?: string;
}) {
  return (
    <div className="health-tooltip-metric">
      <span className="health-tooltip-metric-label">{label}</span>
      <span className="health-tooltip-metric-value">
        {value}
        {suffix && <span className="health-tooltip-metric-suffix"> {suffix}</span>}
      </span>
    </div>
  );
}

// Keep `HealthSmell` import live so future tooltip work that consumes
// the type doesn't have to re-import it.
export type { HealthSmell };
