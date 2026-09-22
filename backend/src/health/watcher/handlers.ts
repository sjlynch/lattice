import path from 'node:path';
import { SOURCE_EXTS } from '../constants.js';
import { loadOrAnalyzeFile, saveCacheBestEffort } from './fileAnalysis.js';
import { broadcast } from './subscribers.js';
import type { ProjectWatcher } from './types.js';

export type WatchEvent = 'add' | 'change';

export type WatcherHandlers = {
  onAddOrChange: (filePath: string, event: WatchEvent) => Promise<void>;
  onRemove: (filePath: string) => Promise<void>;
};

export function createWatcherHandlers(
  proj: ProjectWatcher,
  analyze = loadOrAnalyzeFile,
): WatcherHandlers {
  const runEvent = async (
    filePath: string,
    run: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    const event = proj.revision.begin(filePath);
    try {
      await run(event.isCurrent);
    } finally {
      event.finish();
    }
  };
  return {
    onAddOrChange: (filePath, event) => runEvent(filePath, (isCurrent) =>
      handleAddOrChange(proj, filePath, event, isCurrent, analyze)),
    onRemove: (filePath) => runEvent(filePath, (isCurrent) =>
      handleRemove(proj, filePath, isCurrent)),
  };
}

// A nested tsconfig's `paths` feed the merged alias map but cannot change which
// files are visible: reload the aliases and re-run cross-file (edges may now
// resolve differently) without the full-rescan broadcast. True = handled.
async function reloadNestedAliases(
  proj: ProjectWatcher,
  filePath: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!(await proj.config.reloadAliasesForNestedTsconfig(filePath))) return false;
  if (isCurrent()) proj.crossFile.scheduleRecompute(null);
  return true;
}

async function handleAddOrChange(
  proj: ProjectWatcher,
  filePath: string,
  event: WatchEvent,
  isCurrent: () => boolean,
  analyze: typeof loadOrAnalyzeFile,
): Promise<void> {
  // tsconfig / .gitignore reloads first — they may rewrite the alias map or the
  // ignore predicate, which feeds the per-file analysis below.
  if (await proj.config.reloadForPath(filePath)) {
    if (!isCurrent()) return;
    // Aliases / ignores may have changed. Ask the frontend to refresh the full
    // scan (the visible tree can change), then re-run cross-file with the new
    // alias map so previously-unresolved imports start counting.
    broadcast(proj, { type: 'rescan', reason: 'config', path: filePath });
    proj.watcher.add(proj.root);
    proj.crossFile.scheduleRecompute(null);
    return;
  }
  if (await reloadNestedAliases(proj, filePath, isCurrent)) return;
  if (!isCurrent()) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return;

  // A 'change' event is proof of a write — re-analyze unconditionally rather
  // than trusting the (mtime,size) cache, which can collide on a same-size edit
  // with quantized mtime. 'add'/initial events may still ride the cache.
  const analyzed = await analyze(proj, filePath, ext, {
    forceReanalyze: event === 'change',
    isCurrent,
  });
  if (!analyzed || !isCurrent()) return;

  // A brand-new file can change the root set (it may itself be an entry point);
  // a content edit to an already-tracked file never does. Invalidate the
  // memoized roots only on a genuinely new key so plain saves reuse the cache.
  const isNewFile = !proj.metrics.has(filePath);
  proj.imports.set(filePath, analyzed.imports);
  proj.metrics.set(filePath, analyzed.metrics);
  if (isNewFile) proj.crossFile.invalidateRoots();

  // Coalesce cross-file analysis into a single trailing-edge pass. A burst of
  // file events (checkout, format-all, codegen) now triggers one O(V + E)
  // project pass instead of one per file, de-duplicated and deferred by tens of
  // ms; the end-of-pass diff still emits one `updated` per genuinely-changed
  // file, so WS output is unchanged.
  proj.crossFile.scheduleRecompute(filePath);
}

async function handleRemove(
  proj: ProjectWatcher,
  filePath: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (await proj.config.reloadForPath(filePath)) {
    if (!isCurrent()) return;
    broadcast(proj, { type: 'rescan', reason: 'config', path: filePath });
    proj.watcher.add(proj.root);
    proj.crossFile.scheduleRecompute(null);
    return;
  }
  if (await reloadNestedAliases(proj, filePath, isCurrent)) return;
  if (!isCurrent()) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return;

  proj.imports.delete(filePath);
  const existed = proj.metrics.delete(filePath);
  // Drop the on-disk cache entry too — the previous version only updated the
  // in-memory maps, which let the cache grow unboundedly across renames during a
  // long-running session.
  proj.cache.delete(filePath);
  saveCacheBestEffort(proj);
  // A removed file leaves the root set — invalidate so the coalesced pass
  // recomputes roots from the new membership.
  if (existed) proj.crossFile.invalidateRoots();

  // Tell subscribers the node is gone, then re-run cross-file so anyone who
  // imported it sees their fanOut drop. Coalesced with any concurrent
  // add/change events in the same debounce window.
  broadcast(proj, { type: 'removed', filePath });
  proj.crossFile.scheduleRecompute(null);
}
