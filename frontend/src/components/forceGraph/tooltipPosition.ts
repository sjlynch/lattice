export const TOOLTIP_WIDTH = 320;
export const CURSOR_OFFSET = 16;
export const VIEWPORT_PAD = 12;
// Initial estimate before the tooltip's first paint; refined to the
// actual measured height in HealthTooltip's layout effect.
export const ESTIMATED_HEIGHT = 420;

export type TooltipPosition = { left: number; top: number };

export function clampPosition(
  cursorX: number,
  cursorY: number,
  width: number,
  height: number,
): TooltipPosition {
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
