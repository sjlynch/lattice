import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import {
  analyzeFile,
  applyCrossFile,
  computeCrossFile,
  HealthCache,
  type FileImports,
  type HealthMetrics,
} from './health/index.js';
import { loadProjectAliases, type ParsedAlias } from './health/tsconfig.js';
import { seedWatcherState } from './health/watcher.js';
import { canonicalProjectPath } from './projectPath.js';

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.gradle', '.groovy',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.zig',
  '.cs', '.fs', '.fsx', '.rb', '.erb', '.rake', '.gemspec',
  '.php', '.swift', '.dart',
  '.vue', '.svelte', '.astro',
  '.css', '.scss', '.sass', '.less',
  '.html', '.xml', '.json', '.yaml', '.yml', '.toml', '.csv',
  '.md', '.mdx', '.sh', '.bash', '.zsh', '.ps1', '.sql',
  '.lua', '.r', '.pl', '.pm', '.ex', '.exs', '.erl',
  '.clj', '.cljs', '.hs', '.ml', '.mli', '.nim', '.jl', '.v',
]);

// Directories that are always build artifacts / vendor caches and
// should never be scanned regardless of whether the project's
// .gitignore lists them. Limited to names that are unambiguously
// generated — anything that could plausibly contain source (`bin`,
// `vendor`, `coverage`) is left out so we trust the project's
// .gitignore for those.
const ALWAYS_IGNORE = [
  // Source-control / editor metadata
  '.git',
  '.idea',
  '.vscode',
  '.lattice',
  // JS/TS ecosystem
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.swc',
  // Python
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  // Rust / JVM (this is the one Rust ETL projects hit hardest: `target/`
  // regularly contains GBs of incremental-compilation cache with
  // hundreds of thousands of files. Without this, scanner recursion
  // never terminates in a reasonable time on a Rust project whose
  // .gitignore is missing or incomplete.)
  'target',
  '.gradle',
  // iOS / Xcode
  'Pods',
  'DerivedData',
  // Infrastructure
  '.terraform',
];

export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
  healthDetails?: HealthMetrics;
  loc?: number;
};

const LOC_MAX_BYTES = 5 * 1024 * 1024;

type ReadResult = {
  loc?: number;
  content?: string;
};

// Read the file once, count newlines, and return the decoded content
// when small enough for the health analyzer. Files past LOC_MAX_BYTES
// (5 MB) skip both LOC and health to keep the scan fast.
async function readForAnalysis(filePath: string): Promise<ReadResult> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length === 0) return { loc: 0, content: '' };
    if (buf.length > LOC_MAX_BYTES) return {};
    let count = 0;
    let idx = 0;
    while ((idx = buf.indexOf(0x0a, idx)) !== -1) {
      count++;
      idx++;
    }
    if (buf[buf.length - 1] !== 0x0a) count++;
    return { loc: count, content: buf.toString('utf8') };
  } catch {
    return {};
  }
}

export type GraphLink = {
  source: string;
  target: string;
};

export type ScanResult = {
  root: string;
  nodes: GraphNode[];
  links: GraphLink[];
};

export type TreeAnalysis = ScanResult;

export type FileMetric = {
  filePath: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  loc?: number;
  healthDetails?: HealthMetrics;
  imports: string[];
};

export type CouplingMap = ReturnType<typeof computeCrossFile>;

type DirectoryEntry = {
  id: string;
  name: string;
  path: string;
  parentId: string;
};

type CollectedSourceTree = {
  files: string[];
  directories: DirectoryEntry[];
};

async function loadGitignore(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(ALWAYS_IGNORE);
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // no .gitignore — fine
  }
  return ig;
}

async function collectSourceTree(
  root: string,
  ignoreFilter: Pick<Ignore, 'ignores'>,
): Promise<CollectedSourceTree> {
  const absRoot = canonicalProjectPath(root);
  const files: string[] = [];
  const directories: DirectoryEntry[] = [];

  async function walk(dir: string, parentId: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(absRoot, abs).split(path.sep).join('/');
      if (!rel) continue;
      const testPath = entry.isDirectory() ? `${rel}/` : rel;
      if (ignoreFilter.ignores(testPath)) continue;

      if (entry.isDirectory()) {
        directories.push({ id: abs, name: entry.name, path: abs, parentId });
        await walk(abs, abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) files.push(abs);
      }
    }
  }

  await walk(absRoot, absRoot);
  return { files, directories };
}

export async function collectSourceFiles(
  root: string,
  ignoreFilter: Pick<Ignore, 'ignores'>,
): Promise<string[]> {
  return (await collectSourceTree(root, ignoreFilter)).files;
}

export async function computeFileMetrics(
  files: string[],
  options: { cache?: HealthCache } = {},
): Promise<FileMetric[]> {
  const out: FileMetric[] = [];

  for (const filePath of files) {
    const name = path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    let size = 0;
    let mtimeMs = 0;
    let hasStat = false;
    try {
      const st = await fs.stat(filePath);
      size = st.size;
      mtimeMs = st.mtimeMs;
      hasStat = true;
    } catch {
      // Keep the file in the graph if the directory walk saw it, but
      // skip cache hits because the stat tuple is unknown.
    }

    // Cache hit (matching mtime + size) skips the read + analysis
    // entirely — the typical scan after a no-op refresh costs only
    // the directory walk + stat per file.
    const cached = hasStat ? options.cache?.get(filePath, mtimeMs, size) : undefined;
    let healthDetails: HealthMetrics | undefined;
    let imports: string[] = [];
    let loc: number | undefined;
    if (cached) {
      healthDetails = cached.metrics;
      imports = cached.imports;
      loc = healthDetails.loc;
    } else {
      const read = await readForAnalysis(filePath);
      loc = read.loc;
      if (read.content !== undefined && loc !== undefined) {
        const result = await analyzeFile(read.content, ext, loc);
        healthDetails = result.metrics;
        imports = result.imports;
        if (hasStat) options.cache?.set(filePath, mtimeMs, size, healthDetails, imports);
      }
    }

    out.push({ filePath, name, ext, size, mtimeMs, loc, healthDetails, imports });
  }

  return out;
}

export function computeCoupling(
  metrics: FileMetric[],
  aliases?: readonly ParsedAlias[],
): CouplingMap {
  const fileImports: FileImports[] = [];
  const presentFiles = new Set<string>();
  for (const metric of metrics) {
    presentFiles.add(metric.filePath);
    if (metric.healthDetails) {
      fileImports.push({ filePath: metric.filePath, imports: metric.imports });
    }
  }
  return computeCrossFile(fileImports, presentFiles, aliases);
}

function commonRoot(files: string[]): string {
  if (files.length === 0) return process.cwd();
  let root = path.dirname(files[0]);
  while (
    root !== path.dirname(root) &&
    files.some((file) => path.relative(root, file).startsWith('..'))
  ) {
    root = path.dirname(root);
  }
  return root;
}

function ensureDirectoryNode(
  dir: string,
  root: string,
  nodes: GraphNode[],
  links: GraphLink[],
  seenDirs: Set<string>,
): void {
  if (seenDirs.has(dir)) return;
  const parent = path.dirname(dir);
  if (dir !== root) ensureDirectoryNode(parent, root, nodes, links, seenDirs);
  seenDirs.add(dir);
  nodes.push({ id: dir, name: path.basename(dir) || dir, path: dir, kind: 'dir' });
  if (dir !== root) links.push({ source: parent, target: dir });
}

export function aggregate(
  metrics: FileMetric[],
  coupling: CouplingMap,
  options: { root?: string; directories?: DirectoryEntry[] } = {},
): TreeAnalysis {
  const root = options.root ?? commonRoot(metrics.map((metric) => metric.filePath));
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const seenDirs = new Set<string>();
  const metricsByPath = new Map<string, HealthMetrics>();

  for (const metric of metrics) {
    if (metric.healthDetails) metricsByPath.set(metric.filePath, metric.healthDetails);
  }
  applyCrossFile(metricsByPath, coupling);

  ensureDirectoryNode(root, root, nodes, links, seenDirs);

  if (options.directories) {
    for (const dir of options.directories) {
      if (seenDirs.has(dir.id)) continue;
      seenDirs.add(dir.id);
      nodes.push({ id: dir.id, name: dir.name, path: dir.path, kind: 'dir' });
      links.push({ source: dir.parentId, target: dir.id });
    }
  }

  for (const metric of metrics) {
    const parent = path.dirname(metric.filePath);
    ensureDirectoryNode(parent, root, nodes, links, seenDirs);
    nodes.push({
      id: metric.filePath,
      name: metric.name,
      path: metric.filePath,
      kind: 'file',
      ext: metric.ext,
      size: metric.size,
      health: metric.healthDetails?.score,
      healthDetails: metric.healthDetails,
      loc: metric.loc,
    });
    links.push({ source: parent, target: metric.filePath });
  }

  return { root, nodes, links };
}

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
