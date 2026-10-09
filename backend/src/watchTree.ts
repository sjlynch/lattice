// Recursive directory watcher for the two watchers that cover a whole project
// tree (health + git-status) and the `.git` metadata tree.
//
// Why: chokidar opens an `fs.watch` handle per watched directory AND file, and on
// Windows an open handle anywhere inside a directory makes it un-renameable and
// un-deletable (EPERM) while Lattice has the project open — and agents
// scaffolding apps constantly `mv` / `rm -rf` directories. Node's
// `fs.watch(root, { recursive: true })` uses ONE handle on the root, so nothing
// below it is locked (only the open project root itself stays pinned).
//
// Recursive `fs.watch` is used only on win32 (ReadDirectoryChangesW is native and
// reliable there); other platforms keep chokidar, which has no locking issue.
// `LATTICE_WATCH_MODE=chokidar` (or `=recursive`) forces either when debugging.
//
// Raw `fs.watch` reports only "something happened at this path", so this module
// keeps a `path -> (isDir, mtimeMs, size)` snapshot and derives chokidar's add /
// change / unlink / addDir / unlinkDir events by diffing against it — which also
// thins the chatty, duplicated raw stream (an unchanged (mtime,size) emits nothing).

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
