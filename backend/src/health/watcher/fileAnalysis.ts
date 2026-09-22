import fs from 'node:fs/promises';
import { analyzeFile } from '../analyze.js';
import { LOC_MAX_BYTES, isMinifiedForAnalysis } from '../constants.js';
import { decodeSourceText } from '../decodeSource.js';
import type { HealthMetrics } from '../types.js';
import type { ProjectWatcher } from './types.js';
import { analyzeContentIsolated, WorkerUnavailableError } from './isolatedAnalyze.js';
import { createConcurrencyLimiter } from '../../concurrencyLimit.js';

// How many watcher-driven file reads (+ their analyzer hand-off) may be in
// flight at once, across every open project. The isolated analyzer is a single
// serial worker anyway, so more slots only buffer more whole-file contents
// ahead of it; 8 keeps libuv's thread pool available to everything else.
export const WATCHER_ANALYSIS_CONCURRENCY = 8;
const analysisSlots = createConcurrencyLimiter(WATCHER_ANALYSIS_CONCURRENCY);

export type FileContentForAnalysis = {
  loc: number;
  // Dropped (undefined) when the file is too large / minified to run the health
  // analyzer over — see isMinifiedForAnalysis. The file keeps its graph node but
  // gets no health update.
  content?: string;
};

export type AnalyzedFile = {
  metrics: HealthMetrics;
  imports: string[];
};

export async function readFileForAnalysis(
  filePath: string,
): Promise<FileContentForAnalysis | null> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length > LOC_MAX_BYTES) return null;
    const loc = countLines(buf);
    // Same pathological-content guard the scan path applies: never feed a
    // multi-MB minified bundle to the analyzer's synchronous regex passes (a
    // `change` event on such a file used to bypass this and pin the main thread).
    if (isMinifiedForAnalysis(buf.length, loc)) return { loc };
    return { loc, content: decodeSourceText(buf) };
  } catch {
    return null;
  }
}

export function countLines(buf: Buffer): number {
  let count = 0;
  let idx = 0;
  while ((idx = buf.indexOf(0x0a, idx)) !== -1) {
    count++;
    idx++;
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
  return count;
}

export type LoadOrAnalyzeOptions = {
  // Skip the (mtime,size) cache and re-analyze unconditionally. Set on the
  // watcher's 'change' path: the event itself is proof of a write, so the
  // (mtime,size) key can't be trusted as a freshness guarantee. An in-place
  // edit that preserves byte size whose mtimeMs resolves to the cached value
  // (whole-second mtime quantization + chokidar's awaitWriteFinish coalescing)
  // would otherwise return STALE cached metrics/imports and the file would
  // never be re-analyzed. The cache stays an optimization for 'add'/initial
  // hydration, where no write is implied.
  forceReanalyze?: boolean;
  // Checked after every asynchronous boundary and before mutating the cache.
  isCurrent?: () => boolean;
};

export async function loadOrAnalyzeFile(
  proj: ProjectWatcher,
  filePath: string,
  ext: string,
  opts: LoadOrAnalyzeOptions = {},
  analyzeContent = analyzeContentIsolated,
): Promise<AnalyzedFile | null> {
  const isCurrent = opts.isCurrent ?? (() => true);
  if (!isCurrent()) return null;
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!isCurrent()) return null;

  if (!opts.forceReanalyze) {
    const cached = proj.cache.get(filePath, stat.mtimeMs, stat.size);
    if (cached) return cached;
  }

  // The read + analyze of one file runs under a machine-wide concurrency gate
  // (see `analysisSlots`): the watcher's event handlers are fire-and-forget, so
  // without it a checkout / format-all / codegen run touching thousands of
  // files started that many overlapping reads at once. The (mtime,size) cache
  // check above stays outside the gate — a cache hit costs one stat.
  const analyzed = await analysisSlots.run(async (): Promise<AnalyzedFile | null> => {
    if (!isCurrent()) return null;
    const read = await readFileForAnalysis(filePath);
    if (!isCurrent() || !read || read.content === undefined) return null;

    // Analyze in the WATCHER's warm isolated worker so a pathological changed file
    // can only pin the worker thread, never freeze the backend's event loop. Three
    // outcomes:
    //   - analysis → use it.
    //   - null      → the worker RAN the file and it was unanalyzable (threw or was
    //                 watchdog-killed for hanging) → skip. Must NOT retry in-thread,
    //                 which would re-hang the main thread on a pathological file.
    //   - throw (WorkerUnavailableError) → the worker subsystem is unusable
    //                 (e.g. src under tsx) → fall back to in-thread analysis, which
    //                 keeps its own exception guard.
    try {
      const isolated = await analyzeContent(read.content, ext, read.loc);
      return isolated ? { metrics: isolated.metrics, imports: isolated.imports } : null;
    } catch (err) {
      if (!(err instanceof WorkerUnavailableError)) throw err;
      if (!isCurrent()) return null;
      return analyzeInThread(filePath, read.content, ext, read.loc);
    }
  });
  if (!isCurrent() || !analyzed) return null;

  proj.cache.set(filePath, stat.mtimeMs, stat.size, analyzed.metrics, analyzed.imports);
  saveCacheBestEffort(proj);
  return analyzed;
}

// In-thread fallback, used only when the isolated worker is unavailable. Keeps
// its own exception guard so a thrown analysis degrades this file to "no health"
// rather than rejecting the watcher's add/change handler.
async function analyzeInThread(
  filePath: string,
  content: string,
  ext: string,
  loc: number,
): Promise<AnalyzedFile | null> {
  try {
    const result = await analyzeFile(content, ext, loc);
    return { metrics: result.metrics, imports: result.imports };
  } catch (err) {
    if (process.env.LATTICE_HEALTH_DEBUG) {
      console.error(`[health] analyze failed for ${filePath}:`, err);
    }
    return null;
  }
}

export function saveCacheBestEffort(proj: ProjectWatcher): void {
  // save() coalesces this into a single debounced write, so the watcher can
  // call it after every set()/delete() without re-serializing the whole cache
  // per file change. It's fire-and-forget and never throws.
  proj.cache.save();
}
