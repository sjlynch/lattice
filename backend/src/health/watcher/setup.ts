// Builds a fully-wired ProjectWatcher for one project root: creates the
// HealthCache + cross-file analyzer, hydrates the in-memory mirror from cache,
// spins up the chokidar watcher, and routes its events through the debounced
// handlers. The singleton memoization and shutdown-flush lifecycle live in the
// watcher.ts facade; this module is only the per-root construction/wiring.
//
// The chokidar/recursive-fs.watch split lives in watchTree.ts; this module just
// consumes its chokidar-shaped add/change/unlink/addDir/unlinkDir events.

import { watchTree, type TreeWatcher } from '../../watchTree.js';
import { HealthCache } from '../cache.js';
import { readPackageJsonRoots } from '../crossFile.js';
import { ConfigReloader } from '../configReloader.js';
import { CrossFileAnalyzer } from '../crossFileAnalyzer.js';
import { getUserSettings } from '../../userSettings.js';
import { hydrateWatcherState } from './cacheHydration.js';
import { createWatcherHandlers } from './handlers.js';
import { broadcast } from './subscribers.js';
import type { ProjectWatcher } from './types.js';
import { WatcherRevision } from './revision.js';

// Construct and wire a ProjectWatcher. `registerShutdownFlush` is the facade's
// once-only process-exit flush hook, invoked when the build completes so the
// hook is installed the first time any watcher comes up (behavior unchanged
// from when this call lived inline in the facade).
export async function createWatcher(
  projectRoot: string,
  registerShutdownFlush: () => void,
  revision = new WatcherRevision(),
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
    watcher: undefined as unknown as TreeWatcher,
    cache,
    imports: hydrated.imports,
    metrics: hydrated.metrics,
    config,
    crossFile: undefined as unknown as CrossFileAnalyzer,
    subscribers: new Set(),
    revision,
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

  const watcher = createProjectTreeWatcher(projectRoot, proj);
  proj.watcher = watcher;
  wireWatcherEvents(proj, watcher);

  registerShutdownFlush();
  return proj;
}

function createProjectTreeWatcher(
  projectRoot: string,
  proj: ProjectWatcher,
): TreeWatcher {
  // watchTree, not chokidar directly: on Windows chokidar's per-directory
  // handles make every project directory that has a subdirectory impossible to
  // rename or delete, which breaks the agents working in the project. See
  // watchTree.ts.
  return watchTree(projectRoot, {
    ignored: (filePath, stats) => proj.config.isIgnored(
      filePath,
      stats?.isDirectory() ?? false,
    ),
  });
}

function wireWatcherEvents(proj: ProjectWatcher, watcher: TreeWatcher): void {
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
  // Directory events invalidate the scan revision synchronously (a scan that
  // straddles them must not publish) but broadcast ONE coalesced `rescan`: a
  // checkout / `npm run build` creating forty directories used to push forty
  // rescan frames, and every client re-issued `/api/scan` per frame. File
  // add/change events are already coalesced by the cross-file debounce.
  const rescan = createDirectoryRescanCoalescer(proj);
  watcher.on('addDir', (p) => {
    proj.revision.invalidate();
    if (p !== proj.root) rescan(p);
  });
  watcher.on('unlinkDir', (p) => {
    proj.revision.invalidate();
    if (p !== proj.root) rescan(p);
  });
}

// Trailing-edge window for coalescing a burst of directory add/remove events
// into a single `rescan` broadcast.
export const DIRECTORY_RESCAN_DEBOUNCE_MS = 100;

export function createDirectoryRescanCoalescer(
  proj: ProjectWatcher,
  emit: (p: ProjectWatcher, path: string) => void = (p, path) =>
    broadcast(p, { type: 'rescan', reason: 'directory', path }),
  debounceMs = DIRECTORY_RESCAN_DEBOUNCE_MS,
): (dirPath: string) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = '';
  return (dirPath) => {
    last = dirPath;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      emit(proj, last);
    }, debounceMs);
    timer.unref?.();
  };
}
