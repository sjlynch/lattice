import { isPathInsideRepo } from '../paths.js';
import type { DirtyPaths, SafeDirtyPaths } from './capture.js';

// Parse `git status --porcelain=v1 -z --untracked-files=all` output. We
// treat anything that isn't '??' (untracked) as 'modified' for snapshot
// purposes — staged, unstaged, deleted, type-changed all need preserving.
//
// We use the `-z` (machine-parse) variant on purpose. In the default
// (newline) form git mangles two kinds of path so the snapshot copy then
// fails ENOENT and silently omits the dirty path — violating the
// "snapshot every dirty path" invariant:
//   * a rename is printed as `R  old -> new` (one record), so slice(3)
//     yields the literal string `old -> new`; and
//   * a path with "unusual" bytes (non-ASCII, quotes, control chars) is
//     C-quoted with surrounding double-quotes + octal escapes, e.g.
//     `"\305\233x.txt"`.
// The `-z` form fixes both: records are NUL-terminated (not newline),
// pathnames are emitted verbatim (no quoting/escaping), and a rename/copy
// drops the ` -> ` arrow — emitting the destination path first, then a
// SECOND NUL-separated field with the source path: `R  <new>\0<old>`.
//
// We snapshot the destination (new) path: it's the file that exists on
// disk and carries the user's content. The source path was removed by the
// rename, so there's nothing to copy for it — we consume and discard that
// trailing field so it isn't mis-read as its own record.
export type StatusRecord = {
  x: string;
  y: string;
  file: string;
};

export function parseStatusRecords(out: string): StatusRecord[] {
  const records: StatusRecord[] = [];
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // The trailing NUL leaves an empty final element; a valid record is at
    // least "XY <1-char path>" (length 4).
    if (!field || field.length < 4) continue;
    const x = field[0];
    const y = field[1];
    const file = field.slice(3); // skip the 2-char XY code + its space
    records.push({ x, y, file });
    // Rename/copy: the next NUL-separated field is the source path. Skip it.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      i += 1;
    }
  }
  return records;
}

export function parseStatus(out: string): DirtyPaths {
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const { x, y, file } of parseStatusRecords(out)) {
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
