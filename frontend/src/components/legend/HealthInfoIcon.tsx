import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import type { HealthComponent } from './healthComponents';

// Info-icon button + portal-rendered popover. The popover MUST be
// portaled out of the legend because the legend (and its body, and
// the rows container) all establish overflow / scroll contexts that
// would clip an absolutely-positioned popover trying to render to the
// left of the icon. Portaling to document.body sidesteps every
// containing-block trap. Position is computed from the icon's bounding
// rect on hover/focus (not tracked afterwards), so the popover is placed
// where the icon is when it opens.
const POPOVER_WIDTH = 280;
const POPOVER_GAP = 10;
const POPOVER_VIEWPORT_PAD = 8;

export function HealthInfoIcon({ component }: { component: HealthComponent }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function compute() {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const centerY = r.top + r.height / 2;
    // Prefer the left side; flip right if the popover would overflow
    // the viewport's left edge.
    let x: number;
    if (r.left - POPOVER_GAP - POPOVER_WIDTH >= POPOVER_VIEWPORT_PAD) {
      x = r.left - POPOVER_GAP - POPOVER_WIDTH;
    } else {
      x = r.right + POPOVER_GAP;
    }
    setPos({ x, y: centerY });
  }

  return (
    <>
      <span
        ref={iconRef}
        className="health-legend-info-wrap"
        tabIndex={0}
        role="button"
        aria-label={`More info: ${component.label}`}
        onMouseEnter={compute}
        onMouseLeave={() => setPos(null)}
        onFocus={compute}
        onBlur={() => setPos(null)}
      >
        <Info size={11} className="health-legend-info-icon" />
      </span>
      {pos &&
        createPortal(
          <div
            className="health-legend-info-popover"
            style={{ left: pos.x, top: pos.y }}
            role="tooltip"
          >
            <div className="health-legend-info-popover-title">
              {component.label}
            </div>
            <dl className="health-legend-info-popover-body">
              {component.detail.map((entry) => (
                <div className="health-legend-info-entry" key={entry.label}>
                  <dt>{entry.label}</dt>
                  <dd>{entry.body}</dd>
                </div>
              ))}
            </dl>
          </div>,
          document.body,
        )}
    </>
  );
}
