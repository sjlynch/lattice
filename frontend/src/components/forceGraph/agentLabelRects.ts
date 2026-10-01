// One label to place, in image-plane units (world units divided by depth, so
// every item is measured on the same scale regardless of how far it is).
export type LabelRectInput = {
  // Anchor (the node the label belongs to).
  ax: number;
  ay: number;
  // Label size.
  w: number;
  h: number;
  // Which side of the node the label sits on: 1 = right, -1 = left.
  side: 1 | -1;
  // Horizontal gap between the node centre and the label's near edge.
  gap: number;
  // Preferred vertical offset of the label centre from the anchor.
  dy: number;
};

export type LabelRectOutput = { cx: number; cy: number };

// Greedy, deterministic de-overlap: labels are placed top-down (by preferred
// centre Y, ties by input order) at their preferred spot beside their node; one
// that overlaps an already-placed label is pushed to just below it, re-checked
// against every placed label until it is clear. Horizontal position never
// changes — labels only slide along their node's side, so each stays next to
// its own orb. `padX`/`padY` are the minimum clearances. Pure — unit-tested.
// Relative slack in the overlap test (fraction of the two labels' heights).
const SEPARATION_TOLERANCE = 1e-6;

export function spreadLabelRects(
  items: readonly LabelRectInput[],
  padX: number,
  padY: number,
): LabelRectOutput[] {
  const out: LabelRectOutput[] = items.map((it) => ({
    cx: it.ax + it.side * (it.gap + it.w / 2),
    cy: it.ay + it.dy,
  }));
  const order = items
    .map((_, i) => i)
    .sort((a, b) => out[b].cy - out[a].cy || a - b);
  const placed: number[] = [];
  for (const i of order) {
    const it = items[i];
    const o = out[i];
    // Every push moves strictly below a placed label, so this terminates in at
    // most `placed.length` pushes; the cap is belt-and-braces.
    for (let guard = 0; guard <= placed.length; guard++) {
      let hit = -1;
      for (const j of placed) {
        const p = out[j];
        const q = items[j];
        // The tolerance matters: a label just pushed below `p` sits exactly on
        // the separation boundary, and float rounding (0.3 - 2 - 0.2) can read
        // that as still overlapping — every retry then re-pushed it to the same
        // spot under `p`, the guard ran out, and it was never checked against
        // the label already sitting there, so the two were drawn on top of
        // each other.
        const tol = SEPARATION_TOLERANCE * (it.h + q.h);
        if (
          Math.abs(o.cx - p.cx) < (it.w + q.w) / 2 + padX - tol &&
          Math.abs(o.cy - p.cy) < (it.h + q.h) / 2 + padY - tol
        ) {
          hit = j;
          break;
        }
      }
      if (hit < 0) break;
      o.cy = out[hit].cy - (items[hit].h + it.h) / 2 - padY;
    }
    placed.push(i);
  }
  return out;
}
