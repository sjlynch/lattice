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
import { loadProjectAliases } from './health/tsconfig.js';

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

export async function scan(root: string): Promise<ScanResult> {
  const absRoot = path.resolve(root);
  const ig = await loadGitignore(absRoot);
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  const cache = new HealthCache(absRoot);
  await cache.load();
  const seenFiles = new Set<string>();

  const rootId = absRoot;
  nodes.push({
    id: rootId,
    name: path.basename(absRoot) || absRoot,
    path: absRoot,
    kind: 'dir',
  });

  async function walk(dir: string, parentId: string) {
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
      if (ig.ignores(testPath)) continue;

      if (entry.isDirectory()) {
        nodes.push({ id: abs, name: entry.name, path: abs, kind: 'dir' });
        links.push({ source: parentId, target: abs });
        await walk(abs, abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) continue;
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = await fs.stat(abs);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          // ignore
        }

        seenFiles.add(abs);

        // Cache hit (matching mtime + size) skips the read + analysis
        // entirely — the typical scan after a no-op refresh costs only
        // the directory walk + stat per file.
        const cached = cache.get(abs, mtimeMs, size);
        let healthDetails: HealthMetrics | undefined;
        let imports: string[] = [];
        let loc: number | undefined;
        if (cached) {
          healthDetails = cached.metrics;
          imports = cached.imports;
          loc = healthDetails.loc;
        } else {
          const read = await readForAnalysis(abs);
          loc = read.loc;
          if (read.content !== undefined && loc !== undefined) {
            const result = await analyzeFile(read.content, ext, loc);
            healthDetails = result.metrics;
            imports = result.imports;
            cache.set(abs, mtimeMs, size, healthDetails, imports);
          }
        }
        if (healthDetails) {
          fileImports.push({ filePath: abs, imports });
          metricsByPath.set(abs, healthDetails);
        }

        nodes.push({
          id: abs,
          name: entry.name,
          path: abs,
          kind: 'file',
          ext,
          size,
          health: healthDetails?.score,
          healthDetails,
          loc,
        });
        links.push({ source: parentId, target: abs });
      }
    }
  }

  // Cross-file pass requires the full set of analyzed files first.
  const fileImports: FileImports[] = [];
  const metricsByPath = new Map<string, HealthMetrics>();

  await walk(absRoot, rootId);

  // Resolve imports + apply fan-in/fan-out/cycle analysis. Mutates
  // the HealthMetrics objects in metricsByPath, which the GraphNode
  // entries above reference by identity, so the patched fields show
  // up automatically in the scan response.
  if (fileImports.length > 0) {
    const aliases = await loadProjectAliases(absRoot);
    const cross = computeCrossFile(fileImports, seenFiles, aliases);
    applyCrossFile(metricsByPath, cross);
  }

  cache.prune(seenFiles);
  // Persist asynchronously — don't block the scan response on disk I/O.
  cache.save().catch(() => { /* best-effort */ });

  return { root: absRoot, nodes, links };
}
