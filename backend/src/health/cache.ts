// Persistent per-file health cache, stored alongside the project's other
// Lattice state in `<project>/.lattice/health-cache.json`. The key is the
// absolute file path; entries carry the file's mtime + size so a stale
// cache can be rejected without re-analyzing every file on every scan.
//
// This module owns only the in-memory state and its transitions
// (load/get/set/delete/prune/save/flush). The location/version constants live
// in cachePaths.ts and the crash-safe read/write machinery in cacheFile.ts.

import type { HealthMetrics } from './types.js';
import { CACHE_VERSION } from './cachePaths.js';
import { readCacheFile, writeCacheFile } from './cacheFile.js';

// Quiet period before a coalesced write fires. A burst of set()/delete()
// calls (a branch switch, a formatter touching many files, the watcher
// re-analyzing a save) each re-arms this timer, so the whole burst collapses
// into a single JSON.stringify + writeFile after things settle instead of one
// full re-serialization of the entire cache per file change. flush() forces
// the pending write out immediately when we can't wait (scan done / shutdown).
const SAVE_DEBOUNCE_MS = 300;

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

export class HealthCache {
  private projectRoot: string;
  private data: CacheFile = emptyCache();
  private dirty = false;
  // All writes chain off this promise so two concurrent writers can never
  // race on the same JSON file. Each link snapshots `data` and clears
  // `dirty` before doing the write — concurrent set()s after the snapshot
  // re-mark dirty and a subsequent write picks them up.
  private saveChain: Promise<void> | null = null;
  // Pending debounced-write timer. While set, save() calls are coalesced
  // into the one write it will fire; flush() clears it and writes now. null
  // when no write is scheduled.
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async load(): Promise<void> {
    try {
      const raw = await readCacheFile(this.projectRoot);
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed && parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') {
        // Drop any entry that does not have the shape the readers assume
        // (`metrics.smells.slice()`, `imports.slice()`). A hand-edited or
        // drifted file must cost a re-analysis of that file, not a 500 on
        // every `/api/scan` until someone deletes the cache by hand.
        let dropped = 0;
        for (const [file, entry] of Object.entries(parsed.files)) {
          const e = entry as Partial<Entry> | null;
          const ok = e && typeof e.mtimeMs === 'number' && typeof e.size === 'number'
            && Array.isArray(e.imports) && e.metrics && Array.isArray(e.metrics.smells);
          if (!ok) {
            delete parsed.files[file];
            dropped += 1;
          }
        }
        this.data = parsed;
        if (dropped > 0) this.dirty = true;
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

  // Request a write. Coalescing: a burst of set()/delete()-driven save()
  // calls re-arms a single debounce timer, so we serialize+write the whole
  // cache once after the burst settles instead of once per change. Returns
  // immediately — the write is fire-and-forget (errors are swallowed in
  // _doSave); use flush() when you need to await the result.
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.runSave();
    }, SAVE_DEBOUNCE_MS);
  }

  // Force any pending coalesced write to happen now and resolve once it (and
  // anything already in flight) completes. No-ops cheaply when nothing is
  // dirty. Call on scan completion and process shutdown so a debounced write
  // is never dropped. Never rejects — _doSave swallows write errors.
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.runSave();
  }

  // Queue a write at the end of the chain so two callers can't both be inside
  // fs.writeFile at once (which can corrupt the JSON). The chain never rejects
  // — _doSave swallows write errors so a transient EBUSY doesn't poison every
  // subsequent write.
  private runSave(): Promise<void> {
    // Start the first save synchronously so its disk operation is queued
    // before a newly-created watcher starts loading this project's cache.
    const write = this.saveChain ? this.saveChain.then(() => this._doSave()) : this._doSave();
    this.saveChain = write;
    void write.then(() => {
      if (this.saveChain === write) this.saveChain = null;
    });
    return write;
  }

  private async _doSave(): Promise<void> {
    if (!this.dirty) return;
    // Snapshot before clearing the dirty bit so concurrent set() calls
    // landing while we're writing get picked up by the next save().
    const snapshot = JSON.stringify(this.data);
    this.dirty = false;
    try {
      await writeCacheFile(this.projectRoot, snapshot);
    } catch {
      // Best-effort cache. Re-arm the dirty flag so the next save()
      // tries again instead of leaving the on-disk file stale.
      this.dirty = true;
    }
  }
}
