import path from 'node:path';

// True only when targetPath resolves to a descendant of basePath (never the
// base path itself and never a sibling that merely shares a prefix).
export function isPathStrictlyInside(basePath: string, targetPath: string): boolean {
  if (typeof basePath !== 'string' || typeof targetPath !== 'string') return false;
  if (!basePath || !targetPath) return false;
  if (basePath.includes('\0') || targetPath.includes('\0')) return false;
  const baseResolved = path.resolve(basePath);
  const targetResolved = path.resolve(targetPath);
  return targetResolved.startsWith(baseResolved + path.sep);
}

// Refuse repo-relative paths that, when joined to repoRoot, escape the repo.
// Catches `..` traversal, absolute paths, and OS-specific aliases. Used both
// at snapshot creation (`git status` should never produce such paths, but
// defence in depth) and crucially at restore time, since snapshot manifests
// are JSON on disk that may be tampered with or corrupted between runs.
//
// A bad path here would have snapshot restore writing to `.git/HEAD`, the
// user's home directory, or anywhere else with the user's privileges.
export function isPathInsideRepo(repoRoot: string, filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (filePath.includes('\0')) return false;
  if (path.isAbsolute(filePath)) return false;
  const baseResolved = path.resolve(repoRoot);
  const joined = path.resolve(baseResolved, filePath);
  return isPathStrictlyInside(baseResolved, joined);
}
