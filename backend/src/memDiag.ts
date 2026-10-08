// Memory debug output for the long-lived Node processes (backend and the
// detached terminal-server). See memDiag/CLAUDE.md.
//
//   - every LATTICE_MEM_LOG_MS (default 5 min; 0 disables) one `[mem]` console
//     line: RSS/heap/external, libuv handles by type, the gauges that grew
//     most since start, and any metric that rose monotonically for the whole
//     trend window (`RISING: …` — the leak-shaped signal);
//   - the full sample (every gauge) appended to ~/.lattice/logs/mem-<label>.jsonl;
//   - `memDiagReport()` behind GET /api/debug/memory.
//
// Subsystems expose their long-lived collections with `registerMemGauge`
// beside the collection itself. A value that needs I/O (another process's
// numbers) comes from `registerMemProbe` instead and is read only on the tick.
// The terminal-server imports this file: keep it free of backend-only imports
// (browser samples live in memDiag/browser.ts for that reason).

import v8 from 'node:v8';

import { formatMemLine, processHeadline, topGaugeGrowth } from './memDiag/format.js';
import { registerMemGauge } from './memDiag/gauges.js';
import { appendMemRecord, memLogPath } from './memDiag/logFile.js';
import { sampleSeries, takeMemSample, type MemSample } from './memDiag/sample.js';
import { MemTrend } from './memDiag/trend.js';

export { registerMemGauge };

export const MEM_LOG_ENV = 'LATTICE_MEM_LOG_MS';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 10_000;
// The first line comes early so a fresh boot shows its baseline promptly.
const FIRST_SAMPLE_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;

export function memDiagIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MEM_LOG_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  if (n <= 0) return 0;
  return Math.max(MIN_INTERVAL_MS, n);
}

type MemProbe = () => Promise<Record<string, number>>;
const probes = new Map<string, MemProbe>();

// An async source of gauges (e.g. the terminal-server's own numbers over
// HTTP). Its keys are prefixed `<name>.`; a probe that fails or exceeds
// PROBE_TIMEOUT_MS contributes nothing to that sample.
export function registerMemProbe(name: string, probe: MemProbe): void {
  probes.set(name, probe);
}

async function readProbes(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    [...probes].map(async ([name, probe]) => {
      try {
        const values = await Promise.race([
          probe(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS).unref();
          }),
        ]);
        for (const [k, v] of Object.entries(values)) {
          if (Number.isFinite(v)) out[`${name}.${k}`] = v;
        }
      } catch {
        /* this probe sits this sample out */
      }
    }),
  );
  return out;
}

async function takeFullSample(): Promise<MemSample> {
  const s = takeMemSample();
  Object.assign(s.gauges, await readProbes());
  return s;
}

let label = 'backend';
let started = false;
let intervalMs = 0;
let baseline: MemSample | null = null;
const trend = new MemTrend();

async function tick(): Promise<void> {
  try {
    const s = await takeFullSample();
    trend.push(sampleSeries(s));
    const rising = trend.rising();
    const first = baseline === null;
    if (!baseline) baseline = s;
    console.log(
      formatMemLine({
        label,
        uptimeSec: s.uptimeSec,
        headline: processHeadline(s, first ? null : baseline),
        growth: first ? '' : topGaugeGrowth(baseline.gauges, s.gauges),
        rising,
      }),
    );
    appendMemRecord(label, { ...s, rising });
  } catch {
    /* diagnostics must never take the process down */
  }
}

export function startMemDiag(processLabel: string): void {
  if (started) return;
  started = true;
  label = processLabel;
  intervalMs = memDiagIntervalMs();
  if (intervalMs <= 0) return;
  const first = setTimeout(() => {
    void tick();
    setInterval(() => void tick(), intervalMs).unref();
  }, Math.min(FIRST_SAMPLE_MS, intervalMs));
  first.unref();
}

// Everything known right now (GET /api/debug/memory).
export async function memDiagReport() {
  const sample = await takeFullSample();
  return {
    process: label,
    pid: process.pid,
    intervalMs,
    logFile: memLogPath(label),
    sample,
    baseline,
    rising: trend.rising(),
    heapSpaces: v8.getHeapSpaceStatistics().map((s) => ({
      space: s.space_name,
      usedMB: Math.round(s.space_used_size / 1024 / 1024),
      sizeMB: Math.round(s.space_size / 1024 / 1024),
    })),
  };
}
