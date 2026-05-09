// Canonicalize a project path for use as a cache key, WS subscription key,
// or run-state key. Windows paths are case-insensitive but case-preserving,
// so the same physical project can be addressed as `f:\foo` or `F:\foo` —
// without normalization those produce divergent in-memory caches that point
// at the same on-disk tasks.json. We resolve, then uppercase the drive
// letter (most filesystems display drives uppercase, so it's the natural
// canonical form). The rest of the path is left untouched, since modern
// Windows paths *are* case-preserving and we'd rather not lie about them.
//
// On non-Windows platforms this is just `path.resolve`.

import path from 'node:path';
import crypto from 'node:crypto';

export function canonicalProjectPath(input: string): string {
  if (!input) return input;
  const resolved = path.resolve(input);
  if (process.platform === 'win32' && /^[a-z]:/.test(resolved)) {
    return resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

// Stable per-project key for use as a directory name in shared global
// state (`~/.lattice/per-project/<hash>/`, `~/.lattice/snapshots/<hash>/`).
// SHA-1 of the canonical path, truncated to 12 hex chars — collision risk
// is negligible for the tens-to-hundreds of projects a single user has.
// Always use this rather than rolling your own; otherwise two consumers
// can disagree on which directory belongs to which project.
export function projectHash(projectPath: string): string {
  const canonical = canonicalProjectPath(projectPath);
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}
