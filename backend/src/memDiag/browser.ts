// Browser-tab memory samples (POST /api/debug/client-memory).
//
// Each open Lattice tab posts a sample on the memDiag cadence
// (frontend/src/debug/memDiag.ts); the backend owns the trend + formatting so
// the browser's numbers land in the `npm run dev` console the user already
// watches, and in mem-browser.jsonl. Backend-only (the terminal-server never
// imports this). Bounded: at most MAX_TABS tabs are tracked, least recently
// reporting evicted first.

import { formatMemLine, mb, topGaugeGrowth } from './format.js';
import { registerMemGauge } from './gauges.js';
import { appendMemRecord } from './logFile.js';
import { MemTrend } from './trend.js';

export type BrowserMemSample = {
  tab: string;
  uptimeSec: number;
  heapUsed: number | null;
  heapTotal: number | null;
  heapLimit: number | null;
  gauges: Record<string, number>;
};

type BrowserTab = { trend: MemTrend; baseline: Record<string, number>; last: BrowserMemSample };

const MAX_TABS = 8;
const MAX_GAUGES = 200;
const browserTabs = new Map<string, BrowserTab>();
registerMemGauge('memDiag.browserTabs', () => browserTabs.size);

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function parseBrowserMemSample(body: unknown): BrowserMemSample | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.tab !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(b.tab)) return null;
  const gauges: Record<string, number> = {};
  if (b.gauges && typeof b.gauges === 'object') {
    for (const [k, v] of Object.entries(b.gauges as Record<string, unknown>).slice(0, MAX_GAUGES)) {
      const n = finiteOrNull(v);
      if (n !== null && /^[A-Za-z0-9_.:-]{1,64}$/.test(k)) gauges[k] = n;
    }
  }
  return {
    tab: b.tab,
    uptimeSec: Math.max(0, Math.round(finiteOrNull(b.uptimeSec) ?? 0)),
    heapUsed: finiteOrNull(b.heapUsed),
    heapTotal: finiteOrNull(b.heapTotal),
    heapLimit: finiteOrNull(b.heapLimit),
    gauges,
  };
}

// The gauges worth a slot on the browser's one-line summary, in order.
const BROWSER_HEADLINE: ReadonlyArray<[gauge: string, short: string]> = [
  ['dom.nodes', 'dom'],
  ['gl.geometries', 'gl geo'],
  ['gl.textures', 'gl tex'],
  ['xterm.terminals', 'xterm'],
  ['xterm.pendingChars', 'xterm queued'],
  ['ws.sockets', 'ws'],
  ['vite.hmrUpdates', 'hmr'],
];

export function recordBrowserMemSample(s: BrowserMemSample): string {
  let tab = browserTabs.get(s.tab);
  if (!tab) {
    if (browserTabs.size >= MAX_TABS) browserTabs.delete(browserTabs.keys().next().value!);
    tab = { trend: new MemTrend(), baseline: s.gauges, last: s };
  }
  tab.last = s;
  // Re-insert so eviction drops the least recently reporting tab.
  browserTabs.delete(s.tab);
  browserTabs.set(s.tab, tab);

  const series: Record<string, number> = { ...s.gauges };
  if (s.heapUsed !== null) series['mem.jsHeapUsed'] = s.heapUsed;
  tab.trend.push(series);
  const rising = tab.trend.rising();

  const headline: string[] = [];
  if (s.heapUsed !== null) {
    headline.push(
      `js heap ${mb(s.heapUsed)}` +
        (s.heapTotal !== null ? `/${mb(s.heapTotal)}` : '') +
        (s.heapLimit !== null ? ` (limit ${mb(s.heapLimit)})` : ''),
    );
  }
  for (const [gauge, short] of BROWSER_HEADLINE) {
    if (gauge in s.gauges) headline.push(`${short} ${s.gauges[gauge]}`);
  }
  const line = formatMemLine({
    label: `browser#${s.tab}`,
    uptimeSec: s.uptimeSec,
    headline,
    growth: topGaugeGrowth(tab.baseline, s.gauges),
    rising,
  });
  console.log(line);
  appendMemRecord('browser', { at: new Date().toISOString(), ...s, rising });
  return line;
}

export function browserMemReport() {
  return [...browserTabs.entries()].map(([tab, b]) => ({ tab, last: b.last }));
}
