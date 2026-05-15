import path from 'node:path';
import { SOURCE_EXTS } from '../constants.js';
import { loadOrAnalyzeFile, saveCacheBestEffort } from './fileAnalysis.js';
import { broadcast } from './subscribers.js';
import type { ProjectWatcher } from './types.js';

export type WatcherHandlers = {
  onAddOrChange: (filePath: string) => Promise<void>;
  onRemove: (filePath: string) => Promise<void>;
};

export function createWatcherHandlers(proj: ProjectWatcher): WatcherHandlers {
  return {
    onAddOrChange: (filePath) => handleAddOrChange(proj, filePath),
    onRemove: (filePath) => handleRemove(proj, filePath),
  };
}

async function handleAddOrChange(
  proj: ProjectWatcher,
  filePath: string,
): Promise<void> {
  // tsconfig / .gitignore reloads first — they may rewrite the alias map or the
  // ignore predicate, which feeds the per-file analysis below.
  if (await proj.config.reloadForPath(filePath)) {
    // Aliases / ignores may have changed. Ask the frontend to refresh the full
    // scan (the visible tree can change), then re-run cross-file with the new
    // alias map so previously-unresolved imports start counting.
    broadcast(proj, { type: 'rescan', reason: 'config', path: filePath });
    proj.watcher.add(proj.root);
    proj.crossFile.recomputeAndBroadcast(null);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return;

  const analyzed = await loadOrAnalyzeFile(proj, filePath, ext);
  if (!analyzed) return;

  proj.imports.set(filePath, analyzed.imports);
  proj.metrics.set(filePath, analyzed.metrics);

  // Recompute cross-file analysis using the current snapshot. Cheap for small
  // projects, O(V + E) for SCC; for huge projects we'd want to do an incremental
  // pass, but Lattice's typical project is small enough that a full re-pass is
  // fine (sub-millisecond).
  proj.crossFile.recomputeAndBroadcast(filePath);
}

async function handleRemove(proj: ProjectWatcher, filePath: string): Promise<void> {
  if (await proj.config.reloadForPath(filePath)) {
    broadcast(proj, { type: 'rescan', reason: 'config', path: filePath });
    proj.watcher.add(proj.root);
    proj.crossFile.recomputeAndBroadcast(null);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return;

  proj.imports.delete(filePath);
  proj.metrics.delete(filePath);
  // Drop the on-disk cache entry too — the previous version only updated the
  // in-memory maps, which let the cache grow unboundedly across renames during a
  // long-running session.
  proj.cache.delete(filePath);
  saveCacheBestEffort(proj);

  // Tell subscribers the node is gone, then re-run cross-file so anyone who
  // imported it sees their fanOut drop.
  broadcast(proj, { type: 'removed', filePath });
  proj.crossFile.recomputeAndBroadcast(null);
}
