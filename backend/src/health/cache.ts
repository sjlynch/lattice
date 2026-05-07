// Persistent per-file health cache, stored alongside the project's other
// Lattice state in `<project>/.lattice/health-cache.json`. The key is the
// absolute file path; entries carry the file's mtime + size so a stale
// cache can be rejected without re-analyzing every file on every scan.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HealthMetrics } from './types.js';

// Bump on schema changes — old caches are rejected on load when the
// version doesn't match, forcing re-analysis with the new pipeline.
const CACHE_VERSION = 2;
const CACHE_DIRNAME = '.lattice';
const CACHE_FILENAME = 'health-cache.json';

type Entry = {
  mtimeMs: number;
  size: number;
  metrics: HealthMetrics;
  // Imports are stored alongside metrics so that re-loading the cache
  // gives us enough state to recompute fan-in/fan-out without
  // re-parsing every file.
  imports: string[];
};

type CacheFile = {
  version: number;
  files: Record<string, Entry>;
};

function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, files: {} };
}

function cachePath(projectRoot: string): string {
  return path.join(projectRoot, CACHE_DIRNAME, CACHE_FILENAME);
}

export class HealthCache {
  private projectRoot: string;
  private data: CacheFile = emptyCache();
  private dirty = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(cachePath(this.projectRoot), 'utf8');
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed && parsed.version === CACHE_VERSION && parsed.files) {
        this.data = parsed;
      }
    } catch {
      // Missing or unreadable cache — start fresh.
    }
  }

  // Returns cached metrics + imports if the file's mtime + size match.
  // Stale or missing entries return undefined so the caller re-analyzes.
  get(
    filePath: string,
    mtimeMs: number,
    size: number,
  ): { metrics: HealthMetrics; imports: string[] } | undefined {
    const entry = this.data.files[filePath];
    if (!entry) return undefined;
    if (entry.mtimeMs !== mtimeMs || entry.size !== size) return undefined;
    return { metrics: entry.metrics, imports: entry.imports ?? [] };
  }

  set(
    filePath: string,
    mtimeMs: number,
    size: number,
    metrics: HealthMetrics,
    imports: string[],
  ): void {
    this.data.files[filePath] = { mtimeMs, size, metrics, imports };
    this.dirty = true;
  }

  // Remove entries whose paths are no longer present in the scan, so the
  // cache doesn't grow unboundedly across renames/deletes.
  prune(presentPaths: Set<string>): void {
    let removed = 0;
    for (const key of Object.keys(this.data.files)) {
      if (!presentPaths.has(key)) {
        delete this.data.files[key];
        removed++;
      }
    }
    if (removed > 0) this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.mkdir(path.join(this.projectRoot, CACHE_DIRNAME), { recursive: true });
      await fs.writeFile(
        cachePath(this.projectRoot),
        JSON.stringify(this.data),
        'utf8',
      );
      this.dirty = false;
    } catch {
      // Best-effort cache. Failing to persist is not a scan failure.
    }
  }
}
