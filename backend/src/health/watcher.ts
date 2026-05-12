// File watcher that re-analyzes individual files on save and rebroadcasts
// the new HealthMetrics over a WebSocket. One watcher per project root;
// multiple WS subscribers can share the same watcher.
//
// chokidar handles cross-platform fs.watch quirks (recursive watching
// on Linux, lack of native recursive on some Windows versions, atomic-
// save tempfiles, etc.) so we don't have to.

import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  analyzeFile,
  HealthCache,
  type HealthMetrics,
} from './index.js';
import { LOC_MAX_BYTES, SOURCE_EXTS } from './constants.js';
import { ConfigReloader } from './configReloader.js';
import { CrossFileAnalyzer } from './crossFileAnalyzer.js';
import { canonicalProjectPath } from '../projectPath.js';

export type HealthUpdate = {
  type: 'updated';
  filePath: string;
  metrics: HealthMetrics;
} | {
  type: 'removed';
  filePath: string;
};

type Subscriber = (update: HealthUpdate) => void;

type ProjectWatcher = {
  root: string;
  watcher: FSWatcher;
  cache: HealthCache;
  // Per-project import map kept in memory for cross-file recompute on every
  // change. Hydrated from the on-disk cache when the watcher boots so the FIRST
  // file save reports correct fanIn/fanOut instead of zeros (the cache holds the
  // post-cross-file metrics from the last scan).
  imports: Map<string, string[]>;
  metrics: Map<string, HealthMetrics>;
  config: ConfigReloader;
  crossFile: CrossFileAnalyzer;
  subscribers: Set<Subscriber>;
};

const watchers = new Map<string, ProjectWatcher>();

async function readFileForAnalysis(filePath: string): Promise<{ loc: number; content: string } | null> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length > LOC_MAX_BYTES) return null;
    let count = 0;
    let idx = 0;
    while ((idx = buf.indexOf(0x0a, idx)) !== -1) {
      count++;
      idx++;
    }
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
    return { loc: count, content: buf.toString('utf8') };
  } catch {
    return null;
  }
}

async function ensureWatcher(projectRoot: string): Promise<ProjectWatcher> {
  const existing = watchers.get(projectRoot);
  if (existing) return existing;

  const cache = new HealthCache(projectRoot);
  await cache.load();

  // Hydrate our in-memory mirror from the cache. The cache stores the
  // post-cross-file metrics from the last scanner run, so the very first file
  // save can compute correct fanIn/fanOut against the full import graph instead
  // of seeing only itself.
  const importsMap = new Map<string, string[]>();
  const metricsMap = new Map<string, HealthMetrics>();
  for (const [filePath, entry] of cache.entries()) {
    importsMap.set(filePath, entry.imports ?? []);
    metricsMap.set(filePath, entry.metrics);
  }

  const config = await ConfigReloader.create(projectRoot);

  // Predeclared so the chokidar `ignored` predicate and cross-file broadcast
  // callback can close over the shared project state.
  const proj: ProjectWatcher = {
    root: projectRoot,
    watcher: undefined as unknown as FSWatcher,
    cache,
    imports: importsMap,
    metrics: metricsMap,
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
  });

  const ignored = (filePath: string) => proj.config.isIgnored(filePath);

  const watcher = chokidar.watch(projectRoot, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  proj.watcher = watcher;
  // Without an error listener chokidar will emit 'error' events into the void,
  // which Node treats as an unhandled exception on EventEmitter and crashes the
  // whole backend process. Logging and swallowing keeps the dev server alive even
  // if a watched path disappears or hits a permission issue.
  watcher.on('error', (err) => {
    console.error('[health watcher]', err);
  });

  async function onAddOrChange(filePath: string) {
    // tsconfig / .gitignore reloads first — they may rewrite the alias map or
    // the ignore predicate, which feeds the per-file analysis below.
    if (await proj.config.reloadForPath(filePath)) {
      // Aliases may have changed — re-run cross-file with the new alias map so
      // previously-unresolved imports start counting.
      proj.crossFile.recomputeAndBroadcast(null);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) return;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    const cached = proj.cache.get(filePath, stat.mtimeMs, stat.size);
    let metrics: HealthMetrics | undefined;
    let imports: string[] = [];
    if (cached) {
      metrics = cached.metrics;
      imports = cached.imports;
    } else {
      const read = await readFileForAnalysis(filePath);
      if (!read) return;
      const result = await analyzeFile(read.content, ext, read.loc);
      metrics = result.metrics;
      imports = result.imports;
      proj.cache.set(filePath, stat.mtimeMs, stat.size, metrics, imports);
      proj.cache.save().catch(() => { /* best-effort */ });
    }

    proj.imports.set(filePath, imports);
    proj.metrics.set(filePath, metrics);

    // Recompute cross-file analysis using the current snapshot. Cheap for small
    // projects, O(V + E) for SCC; for huge projects we'd want to do an
    // incremental pass, but Lattice's typical project is small enough that a
    // full re-pass is fine (sub-millisecond).
    proj.crossFile.recomputeAndBroadcast(filePath);
  }

  async function onRemove(filePath: string) {
    if (await proj.config.reloadForPath(filePath)) {
      proj.crossFile.recomputeAndBroadcast(null);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) return;
    proj.imports.delete(filePath);
    proj.metrics.delete(filePath);
    // Drop the on-disk cache entry too — the previous version only updated the
    // in-memory maps, which let the cache grow unboundedly across renames during
    // a long-running session.
    proj.cache.delete(filePath);
    proj.cache.save().catch(() => { /* best-effort */ });
    // Tell subscribers the node is gone, then re-run cross-file so anyone who
    // imported it sees their fanOut drop.
    broadcast(proj, { type: 'removed', filePath });
    proj.crossFile.recomputeAndBroadcast(null);
  }

  watcher.on('add', (p) => { onAddOrChange(p).catch(() => { /* ignore */ }); });
  watcher.on('change', (p) => { onAddOrChange(p).catch(() => { /* ignore */ }); });
  watcher.on('unlink', (p) => { onRemove(p).catch(() => { /* ignore */ }); });

  watchers.set(projectRoot, proj);
  return proj;
}

function broadcast(proj: ProjectWatcher, update: HealthUpdate): void {
  for (const sub of proj.subscribers) {
    try {
      sub(update);
    } catch {
      /* ignore — don't let one bad subscriber break others */
    }
  }
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
