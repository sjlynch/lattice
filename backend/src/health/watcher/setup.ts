// Builds a fully-wired ProjectWatcher for one project root: creates the
// HealthCache + cross-file analyzer, hydrates the in-memory mirror from cache,
// spins up the chokidar watcher, and routes its events through the debounced
// handlers. The singleton memoization and shutdown-flush lifecycle live in the
// watcher.ts facade; this module is only the per-root construction/wiring.
//
// chokidar handles cross-platform fs.watch quirks (recursive watching on Linux,
// lack of native recursive on some Windows versions, atomic-save tempfiles, etc.)
// so we don't have to.

import chokidar, { type FSWatcher } from 'chokidar';
import { HealthCache } from '../cache.js';
import { readPackageJsonRoots } from '../crossFile.js';
import { ConfigReloader } from '../configReloader.js';
import { CrossFileAnalyzer } from '../crossFileAnalyzer.js';
import { getUserSettings } from '../../userSettings.js';
import { hydrateWatcherState } from './cacheHydration.js';
import { createWatcherHandlers } from './handlers.js';
import { broadcast } from './subscribers.js';
import type { ProjectWatcher } from './types.js';

// Construct and wire a ProjectWatcher. `registerShutdownFlush` is the facade's
// once-only process-exit flush hook, invoked when the build completes so the
// hook is installed the first time any watcher comes up (behavior unchanged
// from when this call lived inline in the facade).
export async function createWatcher(
  projectRoot: string,
  registerShutdownFlush: () => void,
): Promise<ProjectWatcher> {
  const cache = new HealthCache(projectRoot);
  await cache.load();

  const hydrated = hydrateWatcherState(cache);
  const config = await ConfigReloader.create(projectRoot);

  // Dead-code root inputs. Conventional roots are recomputed per cross-file
  // pass (cheap); the user's entry globs + package.json entry targets are read
  // once here. Best-effort — a missing settings file / package.json just means
  // fewer explicit roots, which conventional detection mostly covers anyway.
  const entryGlobs = (await getUserSettings(projectRoot)).deadCodeEntryGlobs ?? [];
  const packageRoots = await readPackageJsonRoots(
    projectRoot,
    new Set(hydrated.metrics.keys()),
  );

  // Predeclared so the chokidar `ignored` predicate and cross-file broadcast
  // callback can close over the shared project state.
  const proj: ProjectWatcher = {
    root: projectRoot,
    watcher: undefined as unknown as FSWatcher,
    cache,
    imports: hydrated.imports,
    metrics: hydrated.metrics,
    config,
    crossFile: undefined as unknown as CrossFileAnalyzer,
    subscribers: new Set(),
  };

  proj.crossFile = new CrossFileAnalyzer({
    imports: proj.imports,
    metrics: proj.metrics,
    getAliases: () => proj.config.aliases,
    broadcastUpdated: (filePath, metrics) => {
      broadcast(proj, { type: 'updated', filePath, metrics });
    },
    projectRoot,
    entryGlobs,
    packageRoots,
  });

  const watcher = createChokidarWatcher(projectRoot, proj);
  proj.watcher = watcher;
  wireWatcherEvents(proj, watcher);

  registerShutdownFlush();
  return proj;
}

function createChokidarWatcher(
  projectRoot: string,
  proj: ProjectWatcher,
): FSWatcher {
  return chokidar.watch(projectRoot, {
    ignored: (filePath, stats) => proj.config.isIgnored(
      filePath,
      stats?.isDirectory() ?? false,
    ),
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
}

function wireWatcherEvents(proj: ProjectWatcher, watcher: FSWatcher): void {
  // Without an error listener chokidar will emit 'error' events into the void,
  // which Node treats as an unhandled exception on EventEmitter and crashes the
  // whole backend process. Logging and swallowing keeps the dev server alive even
  // if a watched path disappears or hits a permission issue.
  watcher.on('error', (err) => {
    console.error('[health watcher]', err);
  });

  const { onAddOrChange, onRemove } = createWatcherHandlers(proj);
  watcher.on('add', (p) => { onAddOrChange(p, 'add').catch(() => { /* ignore */ }); });
  watcher.on('change', (p) => { onAddOrChange(p, 'change').catch(() => { /* ignore */ }); });
  watcher.on('unlink', (p) => { onRemove(p).catch(() => { /* ignore */ }); });
  watcher.on('addDir', (p) => {
    if (p !== proj.root) broadcast(proj, { type: 'rescan', reason: 'directory', path: p });
  });
  watcher.on('unlinkDir', (p) => {
    if (p !== proj.root) broadcast(proj, { type: 'rescan', reason: 'directory', path: p });
  });
}
