import type { Stats } from 'node:fs';
import path from 'node:path';
import type { SnapshotEntry } from './types.js';

// Return whether the directory was newly recorded; the watcher owns emission.
export function recordDirectory(
  snapshot: Map<string, SnapshotEntry>,
  dir: string,
): boolean {
  if (snapshot.has(dir)) return false;
  snapshot.set(dir, { dir: true, mtimeMs: 0, size: 0 });
  return true;
}

// Seed walks only insert missing files. Live walks/visits may also replace
// changed entries; only visits can force a change for an event seen pre-seed.
// The returned event describes the update, but emitting it is the caller's job.
export function updateFileSnapshot(
  snapshot: Map<string, SnapshotEntry>,
  filePath: string,
  stats: Pick<Stats, 'mtimeMs' | 'size'>,
  options: { updateExisting: boolean; forceChange?: boolean },
): 'add' | 'change' | undefined {
  const prev = snapshot.get(filePath);
  const next: SnapshotEntry = {
    dir: false,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
  if (!prev) {
    snapshot.set(filePath, next);
    return 'add';
  }
  if (
    options.updateExisting &&
    (options.forceChange || prev.mtimeMs !== next.mtimeMs || prev.size !== next.size)
  ) {
    snapshot.set(filePath, next);
    return 'change';
  }
  return undefined;
}

// Keep snapshot insertion order for rescans, including the root if recorded.
export function subtreePaths(
  snapshot: ReadonlyMap<string, SnapshotEntry>,
  dir: string,
): string[] {
  const prefix = dir + path.sep;
  return [...snapshot.keys()].filter((p) => p === dir || p.startsWith(prefix));
}

export function descendantsDeepestFirst(
  snapshot: ReadonlyMap<string, SnapshotEntry>,
  dir: string,
): string[] {
  // Preserve the original length ordering, with insertion order for ties.
  return subtreePaths(snapshot, dir)
    .filter((p) => p !== dir)
    .sort((a, b) => b.length - a.length);
}
