import fs from 'node:fs/promises';
import { analyzeFile } from '../analyze.js';
import { LOC_MAX_BYTES } from '../constants.js';
import type { HealthMetrics } from '../types.js';
import type { ProjectWatcher } from './types.js';

export type FileContentForAnalysis = {
  loc: number;
  content: string;
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
    return { loc: countLines(buf), content: buf.toString('utf8') };
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

export async function loadOrAnalyzeFile(
  proj: ProjectWatcher,
  filePath: string,
  ext: string,
): Promise<AnalyzedFile | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }

  const cached = proj.cache.get(filePath, stat.mtimeMs, stat.size);
  if (cached) return cached;

  const read = await readFileForAnalysis(filePath);
  if (!read) return null;

  const result = await analyzeFile(read.content, ext, read.loc);
  const analyzed = { metrics: result.metrics, imports: result.imports };
  proj.cache.set(filePath, stat.mtimeMs, stat.size, analyzed.metrics, analyzed.imports);
  saveCacheBestEffort(proj);
  return analyzed;
}

export function saveCacheBestEffort(proj: ProjectWatcher): void {
  // save() coalesces this into a single debounced write, so the watcher can
  // call it after every set()/delete() without re-serializing the whole cache
  // per file change. It's fire-and-forget and never throws.
  proj.cache.save();
}
