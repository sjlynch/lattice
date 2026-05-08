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
import ignore, { type Ignore } from 'ignore';
import {
  analyzeFile,
  applyCrossFile,
  computeCrossFile,
  HealthCache,
  type FileImports,
  type HealthMetrics,
} from './index.js';
import { loadProjectAliases, type ParsedAlias } from './tsconfig.js';

// Same SOURCE_EXTS list the scanner uses; duplicated here to keep the
// two files independent. If they drift the watcher might broadcast
// updates the scanner would have skipped, which is harmless.
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  // Other extensions are scanned but produce only fallback metrics; we
  // still watch them so LOC/universal smells refresh on save.
  '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.dart',
  '.vue', '.svelte', '.astro',
]);

// Names that should never be watched. Chokidar v5 dropped string-glob
// support for the `ignored` option (only RegExp / function / array of
// those are honored), so we use a Set + function predicate instead of
// `**/<name>/**` glob strings — those would silently be treated as
// literal path matches in v5 and chokidar would walk the entire tree
// including node_modules / target, hanging or crashing the process on
// large repos.
const IGNORE_DIR_NAMES = new Set<string>([
  '.git',
  '.idea',
  '.vscode',
  '.lattice',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.swc',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'target',
  '.gradle',
  'Pods',
  'DerivedData',
  '.terraform',
]);

// Predicate fed to chokidar's `ignored` option. The watcher used to
// only honor IGNORE_DIR_NAMES, which let gitignored source files
// (build outputs, generated code, fixtures excluded by the project's
// .gitignore) leak through and broadcast metrics for files that the
// scanner never saw — the frontend would then show ghost nodes that
// disappeared on the next refresh. Loading the project's .gitignore
// keeps the watcher and the scanner in lock-step.
function buildIgnorePredicate(
  projectRoot: string,
  gitignore: Ignore,
): (filePath: string) => boolean {
  return (filePath: string) => {
    // Always-ignore segments take precedence over .gitignore so
    // node_modules / .git / .lattice are blocked even on projects
    // missing a .gitignore.
    const segments = filePath.split(/[\\/]+/);
    for (const seg of segments) {
      if (IGNORE_DIR_NAMES.has(seg)) return true;
    }
    let rel = path.relative(projectRoot, filePath);
    if (!rel || rel.startsWith('..')) return false;
    rel = rel.split(path.sep).join('/');
    if (!rel) return false;
    return gitignore.ignores(rel);
  };
}

async function loadGitignore(projectRoot: string): Promise<Ignore> {
  const ig = ignore();
  try {
    const content = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // No .gitignore — fine, we still have IGNORE_DIR_NAMES.
  }
  return ig;
}

const LOC_MAX_BYTES = 5 * 1024 * 1024;

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
  // Per-project import map kept in memory for cross-file recompute on
  // every change. Hydrated from the on-disk cache when the watcher
  // boots so the FIRST file save reports correct fanIn/fanOut instead
  // of zeros (the cache holds the post-cross-file metrics from the
  // last scan).
  imports: Map<string, string[]>;
  metrics: Map<string, HealthMetrics>;
  // tsconfig path-alias map (TS/JS only). Loaded once at watcher boot;
  // changing tsconfig.json requires restarting the dev server.
  aliases: ParsedAlias[];
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
  // post-cross-file metrics from the last scanner run, so the very
  // first file save can compute correct fanIn/fanOut against the full
  // import graph instead of seeing only itself.
  const importsMap = new Map<string, string[]>();
  const metricsMap = new Map<string, HealthMetrics>();
  for (const [filePath, entry] of cache.entries()) {
    importsMap.set(filePath, entry.imports ?? []);
    metricsMap.set(filePath, entry.metrics);
  }

  const [gitignore, aliases] = await Promise.all([
    loadGitignore(projectRoot),
    loadProjectAliases(projectRoot),
  ]);
  const ignored = buildIgnorePredicate(projectRoot, gitignore);

  const watcher = chokidar.watch(projectRoot, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  // Without an error listener chokidar will emit 'error' events into
  // the void, which Node treats as an unhandled exception on
  // EventEmitter and crashes the whole backend process. Logging and
  // swallowing keeps the dev server alive even if a watched path
  // disappears or hits a permission issue.
  watcher.on('error', (err) => {
    console.error('[health watcher]', err);
  });

  const proj: ProjectWatcher = {
    root: projectRoot,
    watcher,
    cache,
    imports: importsMap,
    metrics: metricsMap,
    aliases,
    subscribers: new Set(),
  };

  async function onAddOrChange(filePath: string) {
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

    // Recompute cross-file analysis using the current snapshot. Cheap
    // for small projects, O(V + E) for SCC; for huge projects we'd
    // want to do an incremental pass, but Lattice's typical project
    // is small enough that a full re-pass is fine (sub-millisecond).
    const fileImports: FileImports[] = [];
    for (const [fp, ims] of proj.imports) {
      fileImports.push({ filePath: fp, imports: ims });
    }
    const presentFiles = new Set(proj.metrics.keys());
    const cross = computeCrossFile(fileImports, presentFiles, proj.aliases);
    applyCrossFile(proj.metrics, cross);

    // The applyCrossFile call mutated `metrics` in place — fetch it
    // again from the map to ensure we broadcast the patched version.
    const finalMetrics = proj.metrics.get(filePath);
    if (!finalMetrics) return;
    broadcast(proj, { type: 'updated', filePath, metrics: finalMetrics });
  }

  function onRemove(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) return;
    proj.imports.delete(filePath);
    proj.metrics.delete(filePath);
    // Drop the on-disk cache entry too — the previous version only
    // updated the in-memory maps, which let the cache grow unboundedly
    // across renames during a long-running session.
    proj.cache.delete(filePath);
    proj.cache.save().catch(() => { /* best-effort */ });
    broadcast(proj, { type: 'removed', filePath });
  }

  watcher.on('add', (p) => { onAddOrChange(p).catch(() => { /* ignore */ }); });
  watcher.on('change', (p) => { onAddOrChange(p).catch(() => { /* ignore */ }); });
  watcher.on('unlink', onRemove);

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

// Subscribe to live health updates for a project. The watcher is
// lazily started on first subscription and kept running for the life
// of the process; subsequent subscribers share it.
export async function subscribeHealth(
  projectRoot: string,
  cb: Subscriber,
): Promise<() => void> {
  const proj = await ensureWatcher(path.resolve(projectRoot));
  proj.subscribers.add(cb);
  return () => proj.subscribers.delete(cb);
}

// Allow the scanner to seed the watcher's in-memory mirror after a
// full scan. Saves the watcher from running redundant cross-file
// passes when WebSocket subscribers connect.
export function seedWatcherState(
  projectRoot: string,
  importsByFile: Map<string, string[]>,
  metricsByFile: Map<string, HealthMetrics>,
): void {
  const abs = path.resolve(projectRoot);
  const proj = watchers.get(abs);
  if (!proj) return;
  proj.imports.clear();
  proj.metrics.clear();
  for (const [k, v] of importsByFile) proj.imports.set(k, v);
  for (const [k, v] of metricsByFile) proj.metrics.set(k, v);
}
