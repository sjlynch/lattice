import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeFile, HealthCache, type HealthMetrics } from '../health/index.js';
import { readForAnalysis } from './readForAnalysis.js';
import {
  runHealthAnalysis,
  type AnalysisJob,
  type JobAnalysis,
} from './healthWorkerRunner.js';

// Re-exported for back-compat: scanner.ts's facade and scannerFileMetrics.test.ts
// import readForAnalysis from here.
export { readForAnalysis };
export type { ReadResult } from './readForAnalysis.js';

export type FileMetric = {
  filePath: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  loc?: number;
  healthDetails?: HealthMetrics;
  imports: string[];
};

// How often to yield to the event loop during the main-thread stat/cache pass.
// The heavy AST/regex analysis now runs in a worker (see healthWorkerRunner),
// but the per-file stat + cache lookup and the in-thread FALLBACK still run
// here; without periodic yields a scan over a few thousand files would starve
// every other request (other projects' /api/scan, /api/settings, WS upgrades)
// for the whole pass. setImmediate at this cadence costs almost nothing.
const YIELD_EVERY_N_FILES = 25;

export type ComputeFileMetricsOptions = {
  cache?: HealthCache;
  // Optional cooperative cancellation. /api/scan sets this true when the
  // client (browser tab) disconnects mid-scan; without it we burn CPU
  // serializing a giant JSON response no subscriber will ever read,
  // which is the typical case when a user refreshes mid-scan.
  isCancelled?: () => boolean;
};

export class ScanCancelledError extends Error {
  constructor() {
    super('scan cancelled');
    this.name = 'ScanCancelledError';
  }
}

type MissJob = AnalysisJob & { hasStat: boolean; size: number; mtimeMs: number };

export async function computeFileMetrics(
  files: string[],
  options: ComputeFileMetricsOptions = {},
): Promise<FileMetric[]> {
  // Filled by index so the returned array preserves input order regardless of
  // when each file's analysis lands (cache hit inline, worker result later).
  const out: FileMetric[] = new Array(files.length);
  const misses: MissJob[] = [];

  // ── Phase 1 (main thread): stat + cache lookup. Cheap and non-hanging. ──
  for (let i = 0; i < files.length; i += 1) {
    if (i > 0 && i % YIELD_EVERY_N_FILES === 0) {
      await new Promise<void>((r) => setImmediate(r));
      if (options.isCancelled?.()) throw new ScanCancelledError();
    }

    const filePath = files[i];
    const name = path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    let size = 0;
    let mtimeMs = 0;
    let hasStat = false;
    try {
      const st = await fs.stat(filePath);
      size = st.size;
      mtimeMs = st.mtimeMs;
      hasStat = true;
    } catch {
      // Keep the file in the graph if the directory walk saw it, but
      // skip cache hits because the stat tuple is unknown.
    }

    // Cache hit (matching mtime + size) skips read + analysis entirely — the
    // typical scan after a no-op refresh costs only the directory walk + stat.
    const cached = hasStat ? options.cache?.get(filePath, mtimeMs, size) : undefined;
    if (cached) {
      out[i] = {
        filePath,
        name,
        ext,
        size,
        mtimeMs,
        loc: cached.metrics.loc,
        healthDetails: cached.metrics,
        imports: cached.imports,
      };
    } else {
      // Placeholder graph node; loc/health filled in by the analysis result.
      out[i] = { filePath, name, ext, size, mtimeMs, loc: undefined, healthDetails: undefined, imports: [] };
      misses.push({ index: i, filePath, ext, hasStat, size, mtimeMs });
    }
  }

  if (misses.length === 0) return out;

  const missByIndex = new Map(misses.map((m) => [m.index, m]));
  const apply = (index: number, loc: number | undefined, analysis: JobAnalysis | null): void => {
    const slot = out[index];
    if (loc !== undefined) slot.loc = loc;
    if (analysis) {
      slot.healthDetails = analysis.metrics;
      slot.imports = analysis.imports;
      const m = missByIndex.get(index);
      if (m?.hasStat && loc !== undefined) {
        options.cache?.set(files[index], m.mtimeMs, m.size, analysis.metrics, analysis.imports);
      }
    }
  };

  // ── Phase 2: analyze cache-misses in an ISOLATED WORKER. A file whose
  // analysis hangs pins only the worker thread; the main event loop keeps
  // serving. The per-file stall watchdog inside runHealthAnalysis terminates a
  // genuinely-hung file and continues. Anything the worker couldn't handle
  // (worker unavailable — e.g. from `src` under tsx — or a respawn-limit tail)
  // comes back as `unhandled` for the in-thread fallback below. ──
  const jobs: AnalysisJob[] = misses.map((m) => ({ index: m.index, filePath: m.filePath, ext: m.ext }));
  const { unhandled } = await runHealthAnalysis(jobs, {
    isCancelled: options.isCancelled,
    onResult: (r) => apply(r.index, r.loc, r.analysis),
  });
  if (options.isCancelled?.()) throw new ScanCancelledError();

  // ── Phase 3: in-thread fallback (same behaviour as before the worker) for
  // jobs the worker didn't handle. Note the watchdog already emitted+skipped any
  // culprit before handing back its tail, so we never re-run a hanging file. ──
  for (let k = 0; k < unhandled.length; k += 1) {
    if (k > 0 && k % YIELD_EVERY_N_FILES === 0) {
      await new Promise<void>((r) => setImmediate(r));
      if (options.isCancelled?.()) throw new ScanCancelledError();
    }
    const job = unhandled[k];
    const read = await readForAnalysis(job.filePath);
    let analysis: JobAnalysis | null = null;
    if (read.content !== undefined && read.loc !== undefined) {
      try {
        const result = await analyzeFile(read.content, job.ext, read.loc);
        analysis = { metrics: result.metrics, imports: result.imports };
      } catch (err) {
        if (process.env.LATTICE_HEALTH_DEBUG) {
          console.error(`[health] analyze failed for ${job.filePath}:`, err);
        }
      }
    }
    apply(job.index, read.loc, analysis);
  }

  return out;
}
