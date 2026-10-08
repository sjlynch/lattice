// The one-line `[mem]` console summary. Pure.

import { isByteMetric, type RisingMetric } from './trend.js';
import type { MemSample } from './sample.js';

const MiB = 1024 * 1024;

export function mb(bytes: number): string {
  return `${Math.round(bytes / MiB)}MB`;
}

export function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function fmtValue(name: string, v: number): string {
  return isByteMetric(name) ? mb(v) : String(v);
}

export function fmtRising(rising: readonly RisingMetric[], max = 4): string {
  return rising
    .slice(0, max)
    .map((r) => `${r.name} ${fmtValue(r.name, r.from)}→${fmtValue(r.name, r.to)}`)
    .join(', ');
}

// Gauges that grew the most since the first sample of this process — the
// "what is getting bigger" list even before a full trend window exists.
export function topGaugeGrowth(
  baseline: Record<string, number>,
  current: Record<string, number>,
  max = 3,
): string {
  return Object.entries(current)
    .map(([name, v]) => ({ name, d: v - (baseline[name] ?? 0) }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d)
    .slice(0, max)
    .map((x) => `${x.name} +${fmtValue(x.name, x.d)}`)
    .join(', ');
}

export function fmtHandles(handles: Record<string, number>, max = 3): string {
  const entries = Object.entries(handles).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, c]) => n + c, 0);
  const top = entries.slice(0, max).map(([t, c]) => `${t} ${c}`).join(', ');
  return top ? `handles ${total} (${top})` : `handles ${total}`;
}

export function formatMemLine(parts: {
  label: string;
  uptimeSec: number;
  headline: readonly string[];
  growth?: string;
  rising: readonly RisingMetric[];
}): string {
  const segs = [`[mem] ${parts.label} up ${fmtUptime(parts.uptimeSec)}`, ...parts.headline];
  if (parts.growth) segs.push(`grew since start: ${parts.growth}`);
  if (parts.rising.length > 0) segs.push(`RISING: ${fmtRising(parts.rising)}`);
  return segs.join(' · ');
}

export function processHeadline(s: MemSample, baseline: MemSample | null): string[] {
  const rssDelta = baseline ? s.rss - baseline.rss : 0;
  const sign = rssDelta >= 0 ? '+' : '-';
  const headline = [
    `rss ${mb(s.rss)}${baseline ? ` (${sign}${mb(Math.abs(rssDelta))})` : ''}`,
    `heap ${mb(s.heapUsed)}/${mb(s.heapTotal)}`,
    `ext ${mb(s.external)} (buffers ${mb(s.arrayBuffers)})`,
    fmtHandles(s.handles),
  ];
  // The terminal-server's numbers, when the backend's executor probe got them.
  const g = s.gauges;
  if ('executor.mem.rss' in g) {
    const workers = g['executor.terminal.conoutWorkers'];
    headline.push(
      `executor rss ${mb(g['executor.mem.rss'])}, ptys ${g['executor.terminal.sessions'] ?? '?'}` +
        (workers !== undefined ? `, pty threads ${workers}` : ''),
    );
  } else if ('executor.terminal.sessions' in g) {
    headline.push(`executor ptys ${g['executor.terminal.sessions']}`);
  }
  return headline;
}
