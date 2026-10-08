// Leak-shaped growth detection over a sliding window of samples. Pure.
//
// A metric is "rising" when it never decreased across the whole window AND
// grew by a meaningful amount. GC noise makes heap numbers saw-tooth, so a
// metric that climbs monotonically for the full window (6 samples × the log
// interval, ~30 min by default) is the signal worth a human's attention.

export type RisingMetric = { name: string; from: number; to: number };

export const TREND_WINDOW = 6;

const MiB = 1024 * 1024;

// Byte-valued metrics carry a `mem.` name segment (`mem.rss`,
// `executor.mem.rss`, `terminal.mem.scrollback`); everything else is a count.
export function isByteMetric(name: string): boolean {
  return /(^|\.)mem\./.test(name);
}

function minGrowth(name: string, from: number): number {
  return isByteMetric(name)
    ? Math.max(8 * MiB, from * 0.1)
    : Math.max(4, from * 0.2);
}

export class MemTrend {
  private readonly history = new Map<string, number[]>();

  constructor(private readonly window = TREND_WINDOW) {}

  push(series: Record<string, number>): void {
    for (const [name, value] of Object.entries(series)) {
      const h = this.history.get(name) ?? [];
      h.push(value);
      if (h.length > this.window) h.shift();
      this.history.set(name, h);
    }
    // A metric that stopped reporting (a handle type that went to zero is
    // simply absent) must not keep a stale full window.
    for (const name of this.history.keys()) {
      if (!(name in series)) this.history.delete(name);
    }
  }

  rising(): RisingMetric[] {
    const out: RisingMetric[] = [];
    for (const [name, h] of this.history) {
      if (h.length < this.window) continue;
      let monotone = true;
      for (let i = 1; i < h.length; i++) {
        if (h[i] < h[i - 1]) {
          monotone = false;
          break;
        }
      }
      const from = h[0];
      const to = h[h.length - 1];
      if (monotone && to - from >= minGrowth(name, from)) out.push({ name, from, to });
    }
    // Biggest relative growth first.
    return out.sort((a, b) => b.to / Math.max(1, b.from) - a.to / Math.max(1, a.from));
  }
}
