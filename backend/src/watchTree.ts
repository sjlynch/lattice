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

import { promises as fsp, watch as fsWatch, type FSWatcher as NodeFSWatcher, type Stats } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';

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

// Coalesce the burst a single editor save / git op / build step emits into one
// pass over the changed paths.
const FLUSH_DEBOUNCE_MS = 100;
// A file whose mtime is younger than this is probably still being written, so
// hold it for another pass rather than analyzing a half-written file. This is
// the cheap stand-in for chokidar's awaitWriteFinish.
const WRITE_STABILITY_MS = 100;
// ...but never hold one forever: a continuously-appended file (a log, a dev
// server's output) would otherwise never be reported at all.
const MAX_STABILITY_RETRIES = 20;

type SnapshotEntry = { dir: boolean; mtimeMs: number; size: number };

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
      awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: 50 },
    }) as unknown as TreeWatcher;
  }
  return new RecursiveTreeWatcher(root, opts);
}

class RecursiveTreeWatcher extends EventEmitter implements TreeWatcher {
  private readonly snapshot = new Map<string, SnapshotEntry>();
  private readonly pending = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly rescanQueue = new Set<string>();
  private watcher: NodeFSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly opts: WatchTreeOptions,
  ) {
    super();
    // Never let a listener-less 'error' take the process down (an EventEmitter
    // 'error' with no listener throws). Both call sites attach one, but the
    // window between construction and `.on('error')` is real.
    this.on('error', () => {});
    void this.start();
  }

  private async start(): Promise<void> {
    // Seed the snapshot before watching so the first real event diffs against
    // known state instead of reporting the whole tree as new.
    await this.walk(this.root, false);
    if (this.closed) return;
    try {
      this.watcher = fsWatch(
        this.root,
        { recursive: true, persistent: true },
        (_event, filename) => {
          if (!filename) {
            // No filename means the OS could not tell us what changed (event
            // buffer overflow under heavy churn). Re-diff the whole tree.
            this.queueRescan(this.root);
            return;
          }
          this.queue(path.resolve(this.root, filename.toString()));
        },
      );
      this.watcher.on('error', (err) => this.emit('error', err));
    } catch (err) {
      this.emit('error', err);
    }
  }

  // Cheap pre-filter + enqueue. Runs once per raw OS event, so it must stay
  // string-only work.
  private queue(filePath: string): void {
    if (this.closed) return;
    if (this.opts.ignored(filePath)) return;
    this.pending.add(filePath);
    this.schedule();
  }

  private queueRescan(dir: string): void {
    if (this.closed) return;
    this.rescanQueue.add(dir);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.timer.unref();
  }

  // Serialized: a change arriving mid-flush just re-schedules, so we never run
  // two overlapping passes over the same paths.
  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      const rescans = [...this.rescanQueue];
      this.rescanQueue.clear();
      for (const dir of rescans) await this.rescan(dir);

      const paths = [...this.pending];
      this.pending.clear();
      for (const p of paths) await this.visit(p);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.flushing = false;
      if (this.pending.size || this.rescanQueue.size) this.schedule();
    }
  }

  // Diff one path against the snapshot and emit whatever actually changed.
  private async visit(filePath: string): Promise<void> {
    let stats: Stats;
    try {
      stats = await fsp.lstat(filePath);
    } catch {
      this.emitRemoval(filePath);
      return;
    }
    // Symlinks are deliberately not followed: a reparse-point loop inside a
    // project (an in-worktree `npm install` of a `file:..` self-dep is the
    // realistic source — see the repo's `.git`-deletion defences) would
    // otherwise make the walk recurse forever.
    if (stats.isSymbolicLink()) return;
    if (this.opts.ignored(filePath, stats)) return;

    if (stats.isDirectory()) {
      if (this.snapshot.has(filePath)) return;
      this.snapshot.set(filePath, { dir: true, mtimeMs: 0, size: 0 });
      this.emit('addDir', filePath);
      // A directory can appear complete (moved/renamed in), and the recursive
      // watch may not replay its contents — walk it so its files are reported.
      await this.walk(filePath, true);
      return;
    }
    if (!stats.isFile()) return;

    // Still being written? Hold it for another pass rather than handing a
    // half-written file to the analyzer.
    const age = Date.now() - stats.mtimeMs;
    const tries = this.retries.get(filePath) ?? 0;
    if (age >= 0 && age < WRITE_STABILITY_MS && tries < MAX_STABILITY_RETRIES) {
      this.retries.set(filePath, tries + 1);
      this.pending.add(filePath);
      return;
    }
    this.retries.delete(filePath);

    const prev = this.snapshot.get(filePath);
    const next: SnapshotEntry = {
      dir: false,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
    if (!prev) {
      this.snapshot.set(filePath, next);
      this.emit('add', filePath);
    } else if (prev.mtimeMs !== next.mtimeMs || prev.size !== next.size) {
      this.snapshot.set(filePath, next);
      this.emit('change', filePath);
    }
  }

  // A path that no longer stats. For a directory that means its whole recorded
  // subtree went with it, and the OS may not report each child separately.
  private emitRemoval(filePath: string): void {
    const entry = this.snapshot.get(filePath);
    if (!entry) return;
    if (entry.dir) {
      const prefix = filePath + path.sep;
      const descendants = [...this.snapshot.keys()].filter((p) =>
        p.startsWith(prefix),
      );
      // Deepest first so subscribers see children go before their parent.
      descendants.sort((a, b) => b.length - a.length);
      for (const child of descendants) {
        const childEntry = this.snapshot.get(child);
        this.snapshot.delete(child);
        this.retries.delete(child);
        this.emit(childEntry?.dir ? 'unlinkDir' : 'unlink', child);
      }
    }
    this.snapshot.delete(filePath);
    this.retries.delete(filePath);
    this.emit(entry.dir ? 'unlinkDir' : 'unlink', filePath);
  }

  // Walk `dir`, recording every entry. With `emit` set, report each newly-seen
  // path (used when a populated directory appears, and by `add()`).
  private async walk(dir: string, emit: boolean): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // vanished mid-walk, or unreadable — nothing to record
    }
    if (!this.snapshot.has(dir) && dir !== this.root) {
      this.snapshot.set(dir, { dir: true, mtimeMs: 0, size: 0 });
      if (emit) this.emit('addDir', dir);
    }
    for (const entry of entries) {
      if (this.closed) return;
      if (entry.isSymbolicLink()) continue;
      const child = path.join(dir, entry.name);
      // Pass a stats-shaped stand-in: the predicate only consults isDirectory().
      const dirLike = { isDirectory: () => entry.isDirectory() } as Stats;
      if (this.opts.ignored(child, dirLike)) continue;
      if (entry.isDirectory()) {
        await this.walk(child, emit);
        continue;
      }
      if (!entry.isFile()) continue;
      let stats: Stats;
      try {
        stats = await fsp.stat(child);
      } catch {
        continue;
      }
      const prev = this.snapshot.get(child);
      const next: SnapshotEntry = {
        dir: false,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
      if (!prev) {
        this.snapshot.set(child, next);
        if (emit) this.emit('add', child);
      } else if (
        emit &&
        (prev.mtimeMs !== next.mtimeMs || prev.size !== next.size)
      ) {
        this.snapshot.set(child, next);
        this.emit('change', child);
      }
    }
  }

  // Re-diff a subtree in both directions: additions/changes from the walk, plus
  // anything the snapshot still lists that has since disappeared.
  private async rescan(dir: string): Promise<void> {
    const before = new Set(
      [...this.snapshot.keys()].filter(
        (p) => p === dir || p.startsWith(dir + path.sep),
      ),
    );
    await this.walk(dir, true);
    for (const p of before) {
      if (!this.snapshot.has(p)) continue;
      try {
        await fsp.lstat(p);
      } catch {
        this.emitRemoval(p);
      }
    }
  }

  // chokidar's `.add()`, used by the config-reload path to re-cover the root
  // after the ignore rules change. Diff-based, so it reports only real
  // differences rather than replaying the whole tree.
  add(paths: string): void {
    this.queueRescan(paths);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.watcher?.close();
    } catch {
      /* already closed */
    }
    this.watcher = null;
    this.pending.clear();
    this.rescanQueue.clear();
    this.snapshot.clear();
  }
}
