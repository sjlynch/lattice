// Shared pure math primitives for the 0–100 health score.
//
// These were previously copy-pasted byte-for-byte into both score.ts and
// scoreModel.ts; consolidating them here keeps the two scorers from silently
// diverging (a drift between the copies would corrupt the health score).

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function norm(x: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  return clamp01((x - lo) / (hi - lo));
}
