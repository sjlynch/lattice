import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

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

const ALWAYS_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  '.venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.lattice',
];

export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
};

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
        try {
          const st = await fs.stat(abs);
          size = st.size;
        } catch {
          // ignore
        }
        nodes.push({
          id: abs,
          name: entry.name,
          path: abs,
          kind: 'file',
          ext,
          size,
          health: 1,
        });
        links.push({ source: parentId, target: abs });
      }
    }
  }

  await walk(absRoot, rootId);
  return { root: absRoot, nodes, links };
}
