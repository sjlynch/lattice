import path from 'node:path';
import type { Ignore } from 'ignore';

export const AST_MAX_BYTES = 1024 * 1024;
export const LARGE_FILE_LOC_THRESHOLD = 800;
export const LOC_MAX_BYTES = 5 * 1024 * 1024;

export const SOURCE_EXTS = new Set([
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

// Directories that are always build artifacts / vendor caches and should never
// be scanned or watched, regardless of whether the project's .gitignore lists
// them. Limited to names that are unambiguously generated — anything that could
// plausibly contain source (`bin`, `vendor`, `coverage`) is left out so we trust
// the project's .gitignore for those.
export const IGNORE_DIR_NAMES = new Set<string>([
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

export function hasIgnoredPathSegment(filePath: string): boolean {
  const segments = filePath.split(/[\\/]+/);
  return segments.some((segment) => IGNORE_DIR_NAMES.has(segment));
}

export function matchIgnoredSourcePath(
  filePath: string,
  projectRoot: string,
  gitignore: Pick<Ignore, 'ignores'>,
): boolean {
  // Always-ignore segments take precedence over .gitignore so node_modules /
  // .git / .lattice are blocked even on projects missing a .gitignore.
  if (hasIgnoredPathSegment(filePath)) return true;

  let rel = path.relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..')) return false;
  rel = rel.split(path.sep).join('/');
  if (!rel) return false;
  return gitignore.ignores(rel);
}
