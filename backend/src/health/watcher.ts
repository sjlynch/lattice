// File watcher that re-analyzes individual files on save and rebroadcasts
// the new HealthMetrics over a WebSocket. One watcher per project root;
// multiple WS subscribers can share the same watcher.
//
// chokidar handles cross-platform fs.watch quirks (recursive watching
// on Linux, lack of native recursive on some Windows versions, atomic-
// save tempfiles, etc.) so we don't have to.

import chokidar, { type FSWatcher } from 'chokidar';
import { HealthCache } from './cache.js';
import type { HealthMetrics } from './types.js';
import { readPackageJsonRoots } from './crossFile.js';
import { ConfigReloader } from './configReloader.js';
import { CrossFileAnalyzer } from './crossFileAnalyzer.js';
import { getUserSettings } from '../userSettings.js';
import { canonicalProjectPath } from '../projectPath.js';
import { hydrateWatcherState } from './watcher/cacheHydration.js';
import { createWatcherHandlers } from './watcher/handlers.js';
import { broadcast } from './watcher/subscribers.js';
import type {
  HealthUpdate,
  ProjectWatcher,
  Subscriber,
} from './watcher/types.js';

export type { HealthUpdate };

const watchers = new Map<string, ProjectWatcher>();

async function ensureWatcher(projectRoot: string): Promise<ProjectWatcher> {
  const existing = watchers.get(projectRoot);
  if (existing) return existing;

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

  watchers.set(projectRoot, proj);
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
  watcher.on('add', (p) => { onAddOrChange(p).catch(() => { /* ignore */ }); });
  watcher.on('change', (p) => { onAddOrChange(p).catch(() => { /* ignore */ }); });
  watcher.on('unlink', (p) => { onRemove(p).catch(() => { /* ignore */ }); });
  watcher.on('addDir', (p) => {
    if (p !== proj.root) broadcast(proj, { type: 'rescan', reason: 'directory', path: p });
  });
  watcher.on('unlinkDir', (p) => {
    if (p !== proj.root) broadcast(proj, { type: 'rescan', reason: 'directory', path: p });
  });
}

// Subscribe to live health updates for a project. The watcher is lazily started
// on first subscription and kept running for the life of the process;
// subsequent subscribers share it.
export async function subscribeHealth(
  projectRoot: string,
  cb: Subscriber,
): Promise<() => void> {
  const proj = await ensureWatcher(canonicalProjectPath(projectRoot));
  proj.subscribers.add(cb);
  return () => proj.subscribers.delete(cb);
}

// Allow the scanner to seed the watcher's in-memory mirror after a full scan.
// Saves the watcher from running redundant cross-file passes when WebSocket
// subscribers connect.
export function seedWatcherState(
  projectRoot: string,
  importsByFile: Map<string, string[]>,
  metricsByFile: Map<string, HealthMetrics>,
): void {
  const abs = canonicalProjectPath(projectRoot);
  const proj = watchers.get(abs);
  if (!proj) return;
  proj.imports.clear();
  proj.metrics.clear();
  for (const [k, v] of importsByFile) proj.imports.set(k, v);
  for (const [k, v] of metricsByFile) proj.metrics.set(k, v);
}
