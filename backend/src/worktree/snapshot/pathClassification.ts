import { isPathInsideRepo } from '../paths.js';
import type { DirtyPaths, SafeDirtyPaths } from './capture.js';

// Parse `git status --porcelain=v1 -uall` output. We treat anything that
// isn't '? ?' (untracked) as 'modified' for snapshot purposes — staged,
// unstaged, deleted, type-changed all need preserving.
export function parseStatus(out: string): DirtyPaths {
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
    } else if (x !== ' ' || y !== ' ') {
      modified.push(file);
    }
  }
  return { modified, untracked };
}

export function filterSafeDirtyPaths(
  repoRoot: string,
  dirty: DirtyPaths,
): SafeDirtyPaths {
  // Defence in depth: filter any path that would escape repoRoot before we
  // touch it. `git status --porcelain` shouldn't produce such paths, but
  // if it ever does — corrupt index, unusual quoting, custom porcelain
  // wrapper — the snapshot copy/delete loop must not reach outside the
  // repo. A path we drop here also won't be reset/deleted, so the user's
  // working tree is left exactly as it was for that path.
  const dropped: string[] = [];
  const modified = dirty.modified.filter((f) => {
    if (isPathInsideRepo(repoRoot, f)) return true;
    dropped.push(f);
    return false;
  });
  const untracked = dirty.untracked.filter((f) => {
    if (isPathInsideRepo(repoRoot, f)) return true;
    dropped.push(f);
    return false;
  });
  return { modified, untracked, dropped };
}

export function classifySafeDirtyPaths(
  repoRoot: string,
  statusOutput: string,
): SafeDirtyPaths {
  return filterSafeDirtyPaths(repoRoot, parseStatus(statusOutput));
}

export function logDroppedPaths(repoRoot: string, dropped: string[]): void {
  if (dropped.length === 0) return;
  console.error(
    `[snapshot] refused to capture ${dropped.length} path(s) outside ` +
      `${repoRoot}: ${dropped.slice(0, 5).join(', ')}` +
      (dropped.length > 5 ? ` (+${dropped.length - 5} more)` : ''),
  );
}
