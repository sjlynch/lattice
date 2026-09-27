import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Full-commit-message tooltip for the timeline scrubber (range chips + track
// hover). Portaled to document.body: the chips sit in an `overflow: hidden`
// row and the timeline bar's backdrop-filter makes it the containing block
// for fixed descendants, either of which would clip or misplace it. Anchored
// above (x, top) in viewport coords, then clamped horizontally so a tick at
// either end of the track never pushes the tooltip off-screen.
const GAP = 10;
const VIEWPORT_PAD = 8;

type Props = {
  x: number;
  top: number;
  text: string;
};

export function CommitTooltip({ x, top, text }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const maxLeft = window.innerWidth - w - VIEWPORT_PAD;
    el.style.left = `${Math.max(VIEWPORT_PAD, Math.min(maxLeft, x - w / 2))}px`;
  }, [x, text]);

  // First paragraph is the sha · author · age line; the rest is the message.
  const split = text.indexOf('\n\n');
  const meta = split === -1 ? null : text.slice(0, split);
  const message = split === -1 ? text : text.slice(split + 2);

  return createPortal(
    <div
      ref={ref}
      className="commit-tooltip"
      role="tooltip"
      style={{ left: x, bottom: window.innerHeight - top + GAP }}
    >
      {meta && <div className="commit-tooltip-meta">{meta}</div>}
      <div className="commit-tooltip-message">{message}</div>
    </div>,
    document.body,
  );
}
