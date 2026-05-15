import type { HealthCache } from '../cache.js';
import type { HealthMetrics } from '../types.js';

export type HydratedWatcherState = {
  imports: Map<string, string[]>;
  metrics: Map<string, HealthMetrics>;
};

// Hydrate the watcher's in-memory mirror from the persistent cache. The cache
// stores post-cross-file metrics from the last scanner run plus each file's raw
// import list, so this gives the very first watch event enough graph context to
// compute correct fanIn/fanOut instead of seeing only the changed file.
export function hydrateWatcherState(
  cache: Pick<HealthCache, 'entries'>,
): HydratedWatcherState {
  const imports = new Map<string, string[]>();
  const metrics = new Map<string, HealthMetrics>();
  for (const [filePath, entry] of cache.entries()) {
    imports.set(filePath, entry.imports ?? []);
    metrics.set(filePath, entry.metrics);
  }
  return { imports, metrics };
}
