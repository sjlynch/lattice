import path from 'node:path';
import type { Ignore } from 'ignore';

export const AST_MAX_BYTES = 1024 * 1024;
export const LARGE_FILE_LOC_THRESHOLD = 800;
export const HIGH_FUNCTION_COUNT = 20;
export const HIGH_COMPLEXITY_THRESHOLD = 15;
export const DEEP_NESTING_THRESHOLD = 5;
export const LONG_FUNCTION_LOC = 75;
export const LONG_PARAM_LIST = 5;
export const LOW_MAINTAINABILITY_MI = 65;
export const MAGIC_STRING_MIN_OCCURRENCES = 3;
export const GOD_FUNCTION_MIN_OTHERS = 4;
export const GOD_FUNCTION_CALL_FRACTION = 0.5;
export const LOC_MAX_BYTES = 5 * 1024 * 1024;

// A file is treated as minified/generated (and NOT fed to the analyzer) when its
// average line length exceeds this. Real source rarely averages >400 chars/line
// even in long-line styles; minified bundles routinely hit thousands. Paired with
// a minimum size so tiny one-liner scripts/configs aren't falsely flagged.
export const MINIFIED_AVG_LINE_LEN = 400;
export const MINIFIED_MIN_BYTES = 64 * 1024;

// Single source of truth for "is this content too pathological to run the health
// analyzer / universal smell regexes over?". The universal regexes (LONG_STRING_RE,
// MAGIC_NUM_RE, …) run synchronously on the main thread over every scanned file;
// on a multi-MB minified bundle MAGIC_NUM_RE alone matches millions of numeric
// literals and can pin a CPU core for minutes, starving every other scan / WS /
// API request. Both read paths — the scan (scanner/fileMetrics.ts) AND the watcher
// (health/watcher/fileAnalysis.ts) — MUST consult this so the guard can't drift
// between them (the watcher path historically lacked it, so a `change` event on a
// big bundle bypassed the protection the scan path had). The file still appears as
// a graph node; it just carries no health metrics, which it couldn't meaningfully
// produce anyway.
export function isMinifiedForAnalysis(byteLength: number, lineCount: number): boolean {
  return (
    byteLength >= MINIFIED_MIN_BYTES &&
    byteLength / Math.max(1, lineCount) >= MINIFIED_AVG_LINE_LEN
  );
}

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

// Windows hands the recursive watcher `\\?\C:\…` (extended-length namespace)
// paths for some events — notably when the watched ROOT itself is deleted or
// renamed. `path.relative` treats that as a different root and returns the
// absolute path unchanged, which the `ignore` package then rejects with a
// RangeError. Thrown from a watcher callback, that took the whole backend
// down the moment a user deleted a project folder Lattice had open. Strip the
// prefix so the path compares like any other.
function stripWindowsNamespacePrefix(p: string): string {
  const m = /^[\\/]{2}\?[\\/](UNC[\\/])?(.*)$/i.exec(p);
  if (!m) return p;
  return m[1] ? `\\\\${m[2]}` : m[2];
}

export function matchIgnoredSourcePath(
  filePath: string,
  projectRoot: string,
  gitignore: Pick<Ignore, 'ignores'>,
  isDirectory = false,
): boolean {
  let rel = path.relative(
    stripWindowsNamespacePrefix(projectRoot),
    stripWindowsNamespacePrefix(filePath),
  );
  if (!rel || rel.startsWith('..')) return false;
  // Still absolute ⇒ the two paths share no root (a drive/UNC mismatch);
  // there is nothing project-relative to match, and `ignore` would throw.
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return false;
  rel = rel.split(path.sep).join('/');
  if (!rel) return false;

  // Always-ignore segments take precedence over .gitignore so node_modules /
  // .git / .lattice are blocked even on projects missing a .gitignore. Check
  // the project-relative path so repos that live under ~/.lattice/worktrees are
  // still watchable.
  if (hasIgnoredPathSegment(rel)) return true;
  // The `ignore` package throws on anything it does not consider a relative
  // path. This runs inside filesystem-watcher callbacks, where a throw is an
  // uncaughtException that kills the backend — so an unexpected shape is
  // "not ignored", never fatal.
  try {
    if (gitignore.ignores(rel)) return true;
    return isDirectory ? gitignore.ignores(`${rel}/`) : false;
  } catch {
    return false;
  }
}
