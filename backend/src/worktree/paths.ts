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

// Top-level repo directories a snapshot must never read from or write into,
// even though they resolve *inside* the repo. `.git` is the dangerous one: a
// corrupt/older-format/tampered manifest listing `.git/HEAD` — or the
// `..\..\.git\HEAD` form the threat model names, which resolves right back to
// `<repo>/.git/HEAD` — would otherwise let restore copy attacker-controlled
// bytes straight onto the gitdir and corrupt the repo. The escape-only check
// below can't catch that (the path resolves *under* repoRoot), and the
// symlink/parent guards in restore.ts don't help either (`.git` is a real
// directory, not a symlink). `.lattice/` is gitignored per-project scratch.
// `git status` emits neither (the gitdir is excluded from status output,
// `.lattice/` is ignored), so a real Lattice snapshot never lists them at
// capture OR restore — refusing them is pure defence in depth that costs
// nothing. Matched case-insensitively on the first path segment: on Windows
// `<repo>\.GIT\HEAD` is the very same file as `.git\HEAD`.
const RESERVED_REPO_DIRS = new Set(['.git', '.lattice']);

// Refuse repo-relative paths that, when joined to repoRoot, escape the repo OR
// land in a reserved directory (`.git` / `.lattice`, see above). Catches `..`
// traversal, absolute paths, OS-specific aliases, and the in-repo `.git/*`
// form. Used both at snapshot creation (`git status` should never produce such
// paths, but defence in depth) and crucially at restore time, since snapshot
// manifests are JSON on disk that may be tampered with or corrupted between
// runs.
//
// A bad path here would have snapshot restore writing to `.git/HEAD`, the
// user's home directory, or anywhere else with the user's privileges.
export function isPathInsideRepo(repoRoot: string, filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (filePath.includes('\0')) return false;
  if (path.isAbsolute(filePath)) return false;
  const baseResolved = path.resolve(repoRoot);
  const joined = path.resolve(baseResolved, filePath);
  if (!isPathStrictlyInside(baseResolved, joined)) return false;
  const firstSegment = path.relative(baseResolved, joined).split(/[\\/]+/)[0];
  if (RESERVED_REPO_DIRS.has(firstSegment.toLowerCase())) return false;
  return true;
}
