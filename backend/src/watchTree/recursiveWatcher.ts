import { promises as fsp, watch as fsWatch, type FSWatcher as NodeFSWatcher, type Stats } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  CASE_INSENSITIVE_FS,
  FLUSH_DEBOUNCE_MS,
  MAX_STABILITY_RETRIES,
  WRITE_STABILITY_MS,
} from './constants.js';
import {
  descendantsDeepestFirst,
  recordDirectory,
  subtreePaths,
  updateFileSnapshot,
} from './snapshot.js';
import type { SnapshotEntry, TreeWatcher, WatchTreeOptions } from './types.js';

export class RecursiveTreeWatcher extends EventEmitter implements TreeWatcher {
  private readonly snapshot = new Map<string, SnapshotEntry>();
  private readonly pending = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly rescanQueue = new Set<string>();
  private watcher: NodeFSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private closed = false;
  // False until the initial walk has populated the snapshot; no flush runs
  // before then (it would diff against a half-built snapshot).
  private seeded = false;
  // Paths whose OS event arrived while the seed walk was still running. The
  // walk may have stat'ed them AFTER the write, so the snapshot already holds
  // the new state and a plain diff would report nothing — these are reported
  // as a `change` regardless.
  private readonly preSeed = new Set<string>();

  private readonly opts: WatchTreeOptions;

  constructor(
    private readonly root: string,
    opts: WatchTreeOptions,
  ) {
    super();
    // The predicate runs inside fs.watch callbacks, where a throw is an
    // uncaughtException that kills the backend (a `\\?\`-prefixed root path on
    // Windows did exactly that). Guard it once here for every caller: an
    // unexpected path shape reads as "not ignored", never fatal.
    const ignored = opts.ignored;
    let warned = false;
    this.opts = {
      ...opts,
      ignored: (filePath, stats) => {
        try {
          return ignored(filePath, stats);
        } catch (err) {
          if (!warned) {
            warned = true;
            console.warn(`[watchTree] ignored() threw for ${filePath}; treating as not ignored:`, err);
          }
          return false;
        }
      },
    };
    // Never let a listener-less 'error' take the process down (an EventEmitter
    // 'error' with no listener throws). Both call sites attach one, but the
    // window between construction and `.on('error')` is real.
    this.on('error', () => {});
    void this.start();
  }

  private async start(): Promise<void> {
    // Arm the OS watch FIRST, then seed the snapshot. Seeding a large tree
    // takes seconds, and a write that lands on a path after the walk stat'ed
    // it but before the watch existed would otherwise never be reported: the
    // snapshot would hold the old (mtime,size) and no event would arrive, so
    // the health cache stayed stale until the file changed again. Events
    // that arrive during the seed are queued (flush waits for `seeded`) and
    // force-reported once it completes — see `preSeed` in visit().
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
    await this.walk(this.root, false);
    if (this.closed) return;
    this.seeded = true;
    if (this.pending.size || this.rescanQueue.size) this.schedule();
  }

  // Cheap pre-filter + enqueue. Runs once per raw OS event, so it must stay
  // string-only work.
  private queue(filePath: string): void {
    if (this.closed) return;
    if (this.opts.ignored(filePath)) return;
    this.pending.add(filePath);
    if (!this.seeded) this.preSeed.add(filePath);
    this.schedule();
  }

  private queueRescan(dir: string): void {
    if (this.closed) return;
    this.rescanQueue.add(dir);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed || !this.seeded) return;
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
    const forced = this.preSeed.delete(filePath);
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
      if (!recordDirectory(this.snapshot, filePath)) {
        await this.dropStaleCaseSpelling(filePath);
        return;
      }
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

    const event = updateFileSnapshot(this.snapshot, filePath, stats, {
      updateExisting: true,
      forceChange: forced,
    });
    if (event) {
      this.emit(event, filePath);
    } else {
      await this.dropStaleCaseSpelling(filePath);
    }
  }

  // On a case-insensitive filesystem a case-only rename (`mv Foo.ts foo.ts`)
  // leaves the OLD spelling still statable, with unchanged (mtime,size) — so
  // the diff above saw "nothing changed" for it while the new spelling was
  // reported as an add, and the snapshot (and every subscriber's graph) kept a
  // phantom `Foo.ts` forever. Only reached on an event that otherwise emits
  // nothing, so the extra realpath is off the common path. The OS's real
  // casing comes back from the native realpath; a basename mismatch means the
  // recorded spelling is gone: report its removal and queue the real one.
  private async dropStaleCaseSpelling(filePath: string): Promise<void> {
    if (!CASE_INSENSITIVE_FS) return;
    let real: string;
    try {
      real = await fsp.realpath(filePath);
    } catch {
      return;
    }
    const actual = path.basename(real);
    if (actual === path.basename(filePath)) return;
    this.emitRemoval(filePath);
    const respelled = path.join(path.dirname(filePath), actual);
    if (!this.snapshot.has(respelled)) {
      this.pending.add(respelled);
      this.schedule();
    }
  }

  // A path that no longer stats. For a directory that means its whole recorded
  // subtree went with it, and the OS may not report each child separately.
  private emitRemoval(filePath: string): void {
    // Before the early return: a file held for write stability and gone by the
    // next pass was never recorded, and its retry count would otherwise stay
    // forever (the `.git` watcher sees a unique `*.lock` per task).
    this.retries.delete(filePath);
    const entry = this.snapshot.get(filePath);
    if (!entry) return;
    if (entry.dir) {
      // Deepest first so subscribers see children go before their parent.
      for (const child of descendantsDeepestFirst(this.snapshot, filePath)) {
        const childEntry = this.snapshot.get(child);
        this.snapshot.delete(child);
        this.retries.delete(child);
        this.emit(childEntry?.dir ? 'unlinkDir' : 'unlink', child);
      }
    }
    this.snapshot.delete(filePath);
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
    if (dir !== this.root && recordDirectory(this.snapshot, dir)) {
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
      const event = updateFileSnapshot(this.snapshot, child, stats, {
        updateExisting: emit,
      });
      if (emit && event) this.emit(event, child);
    }
  }

  // Re-diff a subtree in both directions: additions/changes from the walk, plus
  // anything the snapshot still lists that has since disappeared.
  private async rescan(dir: string): Promise<void> {
    const before = new Set(subtreePaths(this.snapshot, dir));
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

  // Test-only: paths currently held for a write-stability retry.
  get stabilityRetryCount(): number {
    return this.retries.size;
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
    this.retries.clear();
    this.preSeed.clear();
  }
}
