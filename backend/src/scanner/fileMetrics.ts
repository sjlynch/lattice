import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeFile, HealthCache, type HealthMetrics } from '../health/index.js';
import { LOC_MAX_BYTES } from '../health/constants.js';

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

type ReadResult = {
  loc?: number;
  content?: string;
};

// A file is treated as minified/generated when its average line length
// exceeds this. Real source rarely averages >400 chars/line even in
// long-line styles; minified bundles routinely hit thousands. We pair
// this with a minimum size threshold so tiny single-line scripts
// (a one-liner config) don't get falsely flagged.
const MINIFIED_AVG_LINE_LEN = 400;
const MINIFIED_MIN_BYTES = 64 * 1024;

// Read the file once, count newlines, and return the decoded content
// when small enough for the health analyzer. Two cutoffs:
//   - LOC_MAX_BYTES (5 MB): skip both LOC and health entirely.
//   - minified-bundle heuristic: keep the LOC count (newline counting
//     is fast) but DROP the content so analyzeFile / the universal
//     smell regexes never see it. LONG_STRING_RE has a {200,} quantifier
//     over a negative-lookahead alternation, and MAGIC_NUM_RE matches
//     every numeric literal — both cause catastrophic backtracking /
//     millions of matches on a multi-MB minified bundle and can pin a
//     CPU core for minutes, starving every other concurrent scan / WS /
//     API request. A tracked bundle drop-in at the repo root (e.g.
//     a 2.6 MB `tle-api.js`) is the realistic case. The file still
//     appears as a graph node — it just has no health metrics, which
//     it couldn't meaningfully produce anyway.
export async function readForAnalysis(filePath: string): Promise<ReadResult> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length === 0) return { loc: 0, content: '' };
    if (buf.length > LOC_MAX_BYTES) return {};
    let count = 0;
    let idx = 0;
    while ((idx = buf.indexOf(0x0a, idx)) !== -1) {
      count++;
      idx++;
    }
    if (buf[buf.length - 1] !== 0x0a) count++;

    if (
      buf.length >= MINIFIED_MIN_BYTES &&
      buf.length / Math.max(1, count) >= MINIFIED_AVG_LINE_LEN
    ) {
      return { loc: count };
    }

    return { loc: count, content: buf.toString('utf8') };
  } catch {
    return {};
  }
}

// How often to yield to the event loop during analysis. tree-sitter
// parse + AST walk is fully synchronous CPU work; without periodic
// yields a scan over a few thousand files starves every other request
// (other projects' /api/scan, /api/settings, WS upgrades) for the entire
// scan duration — a 30 s scan over project A locks out a freshly-opened
// tab on project B for the same 30 s. setImmediate at this cadence
// costs almost nothing per file but keeps the express loop processing.
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

export async function computeFileMetrics(
  files: string[],
  options: ComputeFileMetricsOptions = {},
): Promise<FileMetric[]> {
  const out: FileMetric[] = [];

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

    // Cache hit (matching mtime + size) skips the read + analysis
    // entirely — the typical scan after a no-op refresh costs only
    // the directory walk + stat per file.
    const cached = hasStat ? options.cache?.get(filePath, mtimeMs, size) : undefined;
    let healthDetails: HealthMetrics | undefined;
    let imports: string[] = [];
    let loc: number | undefined;
    if (cached) {
      healthDetails = cached.metrics;
      imports = cached.imports;
      loc = healthDetails.loc;
    } else {
      const read = await readForAnalysis(filePath);
      loc = read.loc;
      if (read.content !== undefined && loc !== undefined) {
        const result = await analyzeFile(read.content, ext, loc);
        healthDetails = result.metrics;
        imports = result.imports;
        if (hasStat) options.cache?.set(filePath, mtimeMs, size, healthDetails, imports);
      }
    }

    out.push({ filePath, name, ext, size, mtimeMs, loc, healthDetails, imports });
  }

  return out;
}
