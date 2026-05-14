import { HealthCache, type HealthMetrics } from '../health/index.js';
import { loadProjectAliases } from '../health/tsconfig.js';
import { seedWatcherState } from '../health/watcher.js';
import { canonicalProjectPath } from '../projectPath.js';
import { loadGitignore } from './ignore.js';
import { collectSourceTree } from './collectSourceTree.js';
import { computeFileMetrics } from './fileMetrics.js';
import { computeCoupling } from './coupling.js';
import { aggregate, type ScanResult } from './graphAggregate.js';

export async function scan(root: string): Promise<ScanResult> {
  const absRoot = canonicalProjectPath(root);
  const ig = await loadGitignore(absRoot);
  const collected = await collectSourceTree(absRoot, ig);

  const cache = new HealthCache(absRoot);
  await cache.load();

  const metrics = await computeFileMetrics(collected.files, { cache });
  const aliases = await loadProjectAliases(absRoot);
  const coupling = computeCoupling(metrics, aliases);
  const result = aggregate(metrics, coupling, {
    root: absRoot,
    directories: collected.directories,
  });

  const seenFiles = new Set(collected.files);
  cache.prune(seenFiles);
  // Persist asynchronously — don't block the scan response on disk I/O.
  cache.save().catch(() => { /* best-effort */ });

  // Keep the watcher's in-memory mirror in sync with the freshly-scanned
  // state. No-op when the watcher hasn't been started for this project
  // yet; otherwise prevents the watcher from broadcasting cross-file
  // numbers based on a stale view after a manual rescan, file-tree
  // change, or cache version bump.
  const importsByPath = new Map<string, string[]>();
  const metricsByPath = new Map<string, HealthMetrics>();
  for (const metric of metrics) {
    if (!metric.healthDetails) continue;
    importsByPath.set(metric.filePath, metric.imports);
    metricsByPath.set(metric.filePath, metric.healthDetails);
  }
  seedWatcherState(absRoot, importsByPath, metricsByPath);

  return result;
}
