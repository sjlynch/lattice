import type { HealthCache } from '../cache.js';
import type { HealthMetrics } from '../types.js';
import type { ProjectWatcher } from './types.js';
import type { WatcherRevision } from './revision.js';

export type WatcherSlot = {
  creation: Promise<ProjectWatcher>;
  revision: WatcherRevision;
};

// A full scan is a snapshot across many awaits. It may replace watcher state
// only if no file/config event, newer scan, or watcher creation intervened.
export class ScanPublication {
  private latest = new Map<string, symbol>();

  constructor(private getWatcher: (root: string) => WatcherSlot | undefined) {}

  begin(root: string, isCancelled: () => boolean = () => false) {
    const token = Symbol(root);
    this.latest.set(root, token);
    const slot = this.getWatcher(root);
    const revision = slot?.revision.snapshot() ?? null;
    const current = () => !isCancelled() && this.latest.get(root) === token && this.getWatcher(root) === slot;
    return {
      loadCache: async (cache: HealthCache): Promise<void> => {
        const proj = slot && await slot.creation.catch(() => null);
        if (!proj) {
          await cache.load();
          return;
        }
        // A completed edit may still be waiting for its debounced disk save.
        // Prefer the live cache, with independent objects: aggregate mutates
        // cross-file health metrics in place while building the scan result.
        for (const [file, entry] of proj.cache.entries()) {
          const copy = structuredClone(entry);
          cache.set(file, copy.mtimeMs, copy.size, copy.metrics, copy.imports);
        }
      },
      commit: async (
        cache: HealthCache,
        imports: Map<string, string[]>,
        metrics: Map<string, HealthMetrics>,
      ): Promise<boolean> => {
        if (!current()) return false;
        if (slot) {
          const proj = await slot.creation.catch(() => null);
          if (!proj || !current() || !slot.revision.matches(revision)) return false;
          proj.imports.clear();
          proj.metrics.clear();
          for (const [file, value] of imports) proj.imports.set(file, value);
          for (const [file, value] of metrics) proj.metrics.set(file, value);
          proj.crossFile.invalidateRoots();
          // There is one long-lived cache owner once a watcher exists. Seed
          // that owner, rather than letting a one-shot writer race its saves.
          const present = new Set<string>();
          for (const [file, entry] of cache.entries()) {
            present.add(file);
            proj.cache.set(file, entry.mtimeMs, entry.size, entry.metrics, entry.imports);
          }
          proj.cache.prune(present);
          slot.revision.invalidate();
          void proj.cache.flush();
        } else {
          void cache.flush();
        }
        return true;
      },
      finish: () => {
        if (this.latest.get(root) === token) this.latest.delete(root);
      },
    };
  }
}
