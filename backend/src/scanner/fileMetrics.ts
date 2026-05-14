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

// Read the file once, count newlines, and return the decoded content
// when small enough for the health analyzer. Files past LOC_MAX_BYTES
// (5 MB) skip both LOC and health to keep the scan fast.
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
    return { loc: count, content: buf.toString('utf8') };
  } catch {
    return {};
  }
}

export async function computeFileMetrics(
  files: string[],
  options: { cache?: HealthCache } = {},
): Promise<FileMetric[]> {
  const out: FileMetric[] = [];

  for (const filePath of files) {
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
