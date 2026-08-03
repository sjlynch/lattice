import fs from 'node:fs';
import path from 'node:path';

// Why this exists: `fs.watch('dist', {recursive:true})` is NOT a "a file's
// bytes changed" signal on Windows. libuv arms ReadDirectoryChangesW with a
// broad filter (FILE_NAME | DIR_NAME | ATTRIBUTES | SIZE | LAST_WRITE |
// LAST_ACCESS | CREATION | SECURITY), so the watcher also fires for pure
// metadata touches: NTFS flushing a deferred last-access timestamp (this box
// has `fsutil behavior query disablelastaccess` = 0, i.e. last-access updates
// ENABLED), an antivirus/indexer scan, an ACL refresh. The dev runner treated
// every one of those as "code changed" and restarted the backend.
//
// Observed fallout: the backend was respawned mid-workflow with NO dist/ file
// written that day (every dist mtime still on the previous build) — killing an
// in-flight workflow run for no reason. It read as random, because nothing the
// user did caused it.
//
// So: before restarting, confirm something under dist/ actually got written.
// Directory mtimes are included so a create/delete (which doesn't move any
// surviving file's mtime) still counts as a real change.

// Newest mtime under `dir`, in ms. Returns null when the tree can't be read —
// callers must treat that as "can't tell" and fail OPEN (restart anyway), since
// missing a real code change is worse than one spurious restart.
export function newestDistMtimeMs(dir = 'dist') {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      throw new Error('unreadable');
    }
    try {
      newest = Math.max(newest, fs.statSync(current).mtimeMs);
    } catch {
      /* the dir vanished mid-walk — its parent's mtime already moved */
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* raced a delete; the parent dir's mtime covers it */
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return newest;
}

// Pure decision: does this watch event correspond to a real dist/ write?
// `null` on either side means "unknown" → restart (fail open).
export function shouldRestartForDist({ newest, baseline }) {
  if (newest === null || newest === undefined) return true;
  if (baseline === null || baseline === undefined) return true;
  return newest > baseline;
}

// One-line description of the watch event for the restart/ignore log. fs.watch
// gives no filename at all in some cases, which is itself worth surfacing —
// a filename-less event is exactly the metadata-only shape we now ignore.
export function describeDistEvent(eventType, filename) {
  const type = eventType || 'unknown';
  return filename ? `${type} ${filename}` : `${type} (no filename)`;
}
