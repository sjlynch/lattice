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

export type CacheEntry = {
  mtimeMs: number;
  size: number;
  metrics: HealthMetrics;
  // Imports are stored alongside metrics so that re-loading the cache
  // gives us enough state to recompute fan-in/fan-out without
  // re-parsing every file.
  imports: string[];
};
type Entry = CacheEntry;

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
  // All save() calls chain off this promise so two concurrent writers
  // can never race on the same JSON file. Each link snapshots `data`
  // and clears `dirty` before doing the write — concurrent set()s after
  // the snapshot re-mark dirty and a subsequent save() picks them up.
  private saveChain: Promise<void> = Promise.resolve();

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

  delete(filePath: string): void {
    if (this.data.files[filePath]) {
      delete this.data.files[filePath];
      this.dirty = true;
    }
  }

  // Iterate the loaded entries. Used by the watcher to hydrate its
  // in-memory cross-file state when a project is opened, so the very
  // first file save doesn't broadcast bogus fanIn/fanOut numbers.
  *entries(): IterableIterator<[string, CacheEntry]> {
    for (const [k, v] of Object.entries(this.data.files)) {
      yield [k, v];
    }
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

  save(): Promise<void> {
    // Queue ourselves at the end of the chain so two callers that fire
    // save() back-to-back don't both end up inside fs.writeFile at the
    // same time (which can corrupt the JSON). The chain itself never
    // rejects — _doSave swallows write errors so a transient EBUSY
    // doesn't poison every subsequent save.
    this.saveChain = this.saveChain.then(() => this._doSave());
    return this.saveChain;
  }

  private async _doSave(): Promise<void> {
    if (!this.dirty) return;
    // Snapshot before clearing the dirty bit so concurrent set() calls
    // landing while we're writing get picked up by the next save().
    const snapshot = JSON.stringify(this.data);
    this.dirty = false;
    try {
      await fs.mkdir(path.join(this.projectRoot, CACHE_DIRNAME), { recursive: true });
      await fs.writeFile(cachePath(this.projectRoot), snapshot, 'utf8');
    } catch {
      // Best-effort cache. Re-arm the dirty flag so the next save()
      // tries again instead of leaving the on-disk file stale.
      this.dirty = true;
    }
  }
}
