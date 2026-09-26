import type { Stats } from 'node:fs';

export type TreeEventName =
  | 'add'
  | 'change'
  | 'unlink'
  | 'addDir'
  | 'unlinkDir'
  | 'error';

// The slice of chokidar's FSWatcher this codebase actually uses. Both backends
// satisfy it, so call sites are backend-agnostic.
export type TreeWatcher = {
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(
    event: Exclude<TreeEventName, 'error'>,
    listener: (filePath: string) => void,
  ): unknown;
  add(paths: string): unknown;
  close(): Promise<void>;
};

export type WatchTreeOptions = {
  // Same predicate shape chokidar takes. Called with no stats as a cheap
  // pre-filter on the raw event stream (so a `npm install` churning inside
  // node_modules costs one string test per event, not a stat), then again with
  // real stats before anything is emitted.
  ignored: (filePath: string, stats?: Stats) => boolean;
};

export type SnapshotEntry = { dir: boolean; mtimeMs: number; size: number };
