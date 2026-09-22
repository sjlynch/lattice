import { isPathInsideRepo } from '../paths.js';
import type { DirtyPaths, SafeDirtyPaths } from './capture.js';

// Parse `git status --porcelain=v1 -z --untracked-files=all` output into
// the four buckets the capture has to treat differently:
//   * `untracked` (`??`) — copy, then delete the working copy;
//   * `modified`  (tracked, present in HEAD and on disk) — copy, then
//     `git checkout HEAD -- <path>` resets it;
//   * `added`     (`A`/`R`/`C` in the index column: the path is in the index
//     but NOT in HEAD) — copy, `git reset HEAD -- <path>` de-indexes it, then
//     delete the working copy. It used to be classed as `modified`, and since
//     `checkout HEAD` fails on a pathspec HEAD doesn't know, git refused the
//     WHOLE batched checkout — every genuinely modified file in the same
//     command stayed dirty and the fast-forward failed for every task;
//   * `deleted`   (` D`/`D ` — the path exists in HEAD but not on disk; also a
//     rename's source) — nothing to copy; `git checkout HEAD -- <path>` brings
//     it back so the FF sees a clean tree, and restore re-deletes it. It also
//     used to be `modified`, where the copy failed ENOENT and the path was
//     left out of the reset set, so the FF refused on the local deletion.
// `MD` (staged edit, then deleted on disk) stays `modified`: the index holds
// content the working tree doesn't, and resetting it would lose that; the copy
// fails and the path is left dirty, exactly as before.
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
  // Rename/copy source path (the second NUL-separated field), when present.
  from?: string;
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
    const record: StatusRecord = { x, y, file };
    // Rename/copy: the next NUL-separated field is the source path. Consume
    // it so it isn't mis-read as its own record.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      i += 1;
      const from = fields[i];
      if (from) record.from = from;
    }
    records.push(record);
  }
  return records;
}

export function parseStatus(out: string): DirtyPaths {
  const modified: string[] = [];
  const untracked: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const { x, y, file, from } of parseStatusRecords(out)) {
    if (x === '?' && y === '?') {
      untracked.push(file);
    } else if (x === ' ' && y === ' ') {
      continue;
    } else if (x === 'A' || x === 'R' || x === 'C') {
      // Index-only entry: not in HEAD. A staged rename's source is gone from
      // both the index and the working tree but still in HEAD — a deletion.
      added.push(file);
      if (x === 'R' && from) deleted.push(from);
    } else if ((y === 'D' && (x === ' ' || x === 'D')) || (x === 'D' && y === ' ')) {
      deleted.push(file);
    } else {
      modified.push(file);
    }
  }
  return { modified, untracked, added, deleted };
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
  const keep = (files: readonly string[] | undefined): string[] =>
    (files ?? []).filter((f) => {
      if (isPathInsideRepo(repoRoot, f)) return true;
      dropped.push(f);
      return false;
    });
  const modified = keep(dirty.modified);
  const untracked = keep(dirty.untracked);
  const added = keep(dirty.added);
  const deleted = keep(dirty.deleted);
  return { modified, untracked, added, deleted, dropped };
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
