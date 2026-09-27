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

// How many `fs.stat`s to keep in flight at once during phase 1. A serial
// await per file cost one thread-pool round trip per file (20k of them on a
// large tree, before any analysis started — even on a fully cached refresh).
const STAT_BATCH = 32;

// Files the analyzer could NOT produce metrics for (a minified bundle, a file
// that threw, a watchdog-killed hang), keyed by path with the (mtime,size) the
// verdict was reached at. The health cache only stores positive results, so
// without this every scan re-read and re-attempted the same pathological
// file — for a watchdog culprit that is a 10 s stall + a worker respawn on
// EVERY `/api/scan`, forever. Process-lifetime memo; an entry is dropped the
// moment the file analyzes successfully or its (mtime,size) moves.
const unanalyzable = new Map<string, { mtimeMs: number; size: number; loc: number | undefined }>();

// Yield the event loop once, then re-check cancellation — the shared step
// between batches (phase 1) and every YIELD_EVERY_N_FILES files (phase 3).
async function yieldAndCheckCancelled(options: ComputeFileMetricsOptions): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  if (options.isCancelled?.()) throw new ScanCancelledError();
}

// ── Phase 1 (main thread): stat + cache lookup. Cheap and non-hanging.
// Stats run STAT_BATCH at a time; the event loop is yielded between
// batches so other requests keep being served during a large pass. ──
async function statAndLookup(
  files: string[],
  options: ComputeFileMetricsOptions,
): Promise<{ out: FileMetric[]; misses: MissJob[] }> {
  // Filled by index so the returned array preserves input order regardless of
  // when each file's analysis lands (cache hit inline, worker result later).
  const out: FileMetric[] = new Array(files.length);
  const misses: MissJob[] = [];

  for (let start = 0; start < files.length; start += STAT_BATCH) {
    if (options.isCancelled?.()) throw new ScanCancelledError();
    if (start > 0) await yieldAndCheckCancelled(options);
    const slice = files.slice(start, start + STAT_BATCH);
    const stats = await Promise.all(slice.map((f) => fs.stat(f).then((st) => st, () => null)));

    for (let k = 0; k < slice.length; k += 1) {
      const i = start + k;
      const filePath = slice[k];
      const name = path.basename(filePath);
      const ext = path.extname(name).toLowerCase();
      // A file the directory walk saw but that no longer stats stays in the
      // graph, but skips cache hits because the stat tuple is unknown.
      const st = stats[k];
      const hasStat = st !== null;
      const size = st ? st.size : 0;
      const mtimeMs = st ? st.mtimeMs : 0;

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
        continue;
      }
      const skipped = hasStat ? unanalyzable.get(filePath) : undefined;
      if (skipped && skipped.mtimeMs === mtimeMs && skipped.size === size) {
        out[i] = { filePath, name, ext, size, mtimeMs, loc: skipped.loc, healthDetails: undefined, imports: [] };
        continue;
      }
      // Placeholder graph node; loc/health filled in by the analysis result.
      out[i] = { filePath, name, ext, size, mtimeMs, loc: undefined, healthDetails: undefined, imports: [] };
      misses.push({ index: i, filePath, ext, hasStat, size, mtimeMs });
    }
  }

  return { out, misses };
}

type ApplyResult = (index: number, loc: number | undefined, analysis: JobAnalysis | null) => void;

// Lands one analysis result (worker or in-thread) into its `out` slot. The
// health cache is written only for a stat'd file with a known `loc`; the
// `unanalyzable` memo is cleared on success and set on a stat'd failure.
function createResultApplier(
  files: string[],
  out: FileMetric[],
  misses: MissJob[],
  options: ComputeFileMetricsOptions,
): ApplyResult {
  const missByIndex = new Map(misses.map((m) => [m.index, m]));
  return (index, loc, analysis) => {
    const slot = out[index];
    if (loc !== undefined) slot.loc = loc;
    const m = missByIndex.get(index);
    if (analysis) {
      slot.healthDetails = analysis.metrics;
      slot.imports = analysis.imports;
      unanalyzable.delete(files[index]);
      if (m?.hasStat && loc !== undefined) {
        options.cache?.set(files[index], m.mtimeMs, m.size, analysis.metrics, analysis.imports);
      }
    } else if (m?.hasStat) {
      unanalyzable.set(files[index], { mtimeMs: m.mtimeMs, size: m.size, loc });
    }
  };
}

// ── Phase 3: in-thread fallback (same behaviour as before the worker) for
// jobs the worker didn't handle. Note the watchdog already emitted+skipped any
// culprit before handing back its tail, so we never re-run a hanging file. ──
async function analyzeInThread(
  unhandled: AnalysisJob[],
  apply: ApplyResult,
  options: ComputeFileMetricsOptions,
): Promise<void> {
  for (let k = 0; k < unhandled.length; k += 1) {
    if (options.isCancelled?.()) throw new ScanCancelledError();
    if (k > 0 && k % YIELD_EVERY_N_FILES === 0) await yieldAndCheckCancelled(options);
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
}

export async function computeFileMetrics(
  files: string[],
  options: ComputeFileMetricsOptions = {},
): Promise<FileMetric[]> {
  if (options.isCancelled?.()) throw new ScanCancelledError();

  const { out, misses } = await statAndLookup(files, options);
  if (misses.length === 0) return out;

  const apply = createResultApplier(files, out, misses, options);

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

  await analyzeInThread(unhandled, apply, options);

  return out;
}
