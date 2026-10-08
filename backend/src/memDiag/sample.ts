// One memory sample of THIS process: V8/RSS numbers, libuv handles grouped by
// type, and every registered size gauge.
//
// The handle counts are the zero-integration leak signal: a timer, socket,
// fs watcher or child-process handle that is created per event and never
// closed shows up as a climbing `Timeout` / `TCPSocketWrap` / `FSEventWrap` /
// `ProcessWrap` count without anyone having registered a gauge for it.

import { readMemGauges } from './gauges.js';

export type MemSample = {
  at: string;
  uptimeSec: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  handles: Record<string, number>;
  gauges: Record<string, number>;
};

export function countActiveHandles(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const type of process.getActiveResourcesInfo()) out[type] = (out[type] ?? 0) + 1;
  } catch {
    /* unavailable on this runtime */
  }
  return out;
}

export function takeMemSample(): MemSample {
  const mem = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    handles: countActiveHandles(),
    gauges: readMemGauges(),
  };
}

// Flatten to one namespace for trend tracking: byte metrics are `mem.*` (the
// trend thresholds key off that prefix), handle types `handles.*`, gauges by
// their own names.
export function sampleSeries(s: MemSample): Record<string, number> {
  const series: Record<string, number> = {
    'mem.rss': s.rss,
    'mem.heapUsed': s.heapUsed,
    'mem.external': s.external,
    'mem.arrayBuffers': s.arrayBuffers,
  };
  let total = 0;
  for (const [type, n] of Object.entries(s.handles)) {
    series[`handles.${type}`] = n;
    total += n;
  }
  series['handles.total'] = total;
  for (const [name, v] of Object.entries(s.gauges)) series[name] = v;
  return series;
}
