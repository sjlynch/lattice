// Recursive directory watcher for the two watchers that cover a whole project
// tree (health + git-status) and the `.git` metadata tree.
//
// WHY THIS EXISTS — the Windows directory lock
// --------------------------------------------
// chokidar opens one `fs.watch` handle per watched directory AND per watched
// file. On Windows an open handle anywhere *inside* a directory makes that
// directory un-renameable and un-deletable: `mv src old-src` / `rm -rf pkg`
// fail with EPERM ("Access is denied") for as long as Lattice has the project
// open. That is not a theoretical concern here — every Lattice project has a
// coding agent working in it, and scaffolding a new app is largely `mkdir` /
// `mv` / `rm -rf` of directories. Reproduced deterministically: with the
// backend up, a directory containing any subdirectory cannot be renamed; kill
// the backend and the same rename succeeds.
//
// Node's `fs.watch(root, { recursive: true })` covers the entire subtree with a
// SINGLE handle on the root, so nothing below the root is ever locked. Only the
// project root itself stays pinned, which is fine — nobody renames the folder
// they currently have open in Lattice.
//
// Recursive `fs.watch` is only used on win32, where the lock is the problem and
// the platform's ReadDirectoryChangesW backing is native and reliable. Every
// other platform keeps chokidar, which has no locking issue there. Set
// `LATTICE_WATCH_MODE=chokidar` (or `=recursive`) to force either backend when
// debugging.
//
// Raw `fs.watch` reports only "something happened at this path", so this module
// keeps a `path -> (isDir, mtimeMs, size)` snapshot and derives chokidar's
// add / change / unlink / addDir / unlinkDir events by diffing against it. That
// diffing is also what makes the events *fewer* than the raw stream: recursive
// watch is chatty and duplicates events, and a path whose (mtime,size) is
// unchanged emits nothing.

import chokidar from 'chokidar';
import { CHOKIDAR_POLL_INTERVAL_MS, WRITE_STABILITY_MS } from './watchTree/constants.js';
import { RecursiveTreeWatcher } from './watchTree/recursiveWatcher.js';
import type { TreeWatcher, WatchTreeOptions } from './watchTree/types.js';

export type { TreeEventName, TreeWatcher, WatchTreeOptions } from './watchTree/types.js';

function useRecursiveBackend(): boolean {
  const mode = process.env.LATTICE_WATCH_MODE;
  if (mode === 'chokidar') return false;
  if (mode === 'recursive') return true;
  return process.platform === 'win32';
}

// Watch `root` recursively. Emits chokidar-shaped events; initial contents are
// never emitted (both call sites pass chokidar's `ignoreInitial: true`).
export function watchTree(root: string, opts: WatchTreeOptions): TreeWatcher {
  if (!useRecursiveBackend()) {
    return chokidar.watch(root, {
      ignored: opts.ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: WRITE_STABILITY_MS,
        pollInterval: CHOKIDAR_POLL_INTERVAL_MS,
      },
    }) as unknown as TreeWatcher;
  }
  return new RecursiveTreeWatcher(root, opts);
}
