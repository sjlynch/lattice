import fs from 'node:fs';
import path from 'node:path';
import { terminalScrollbackDir } from '../projectPath.js';
import { TERMINAL_CONFIG } from '../terminalConfig.js';
import { readTail, readTailAsync } from './scrollbackLogFile.js';
import fsp from 'node:fs/promises';

// Per-session terminal scrollback, persisted to a small on-disk append log so
// the replay window can be large without holding all history in memory.
//
// Why disk-backed: the previous SessionBuffer kept the whole replay buffer in
// memory and capped it at ~200 KB. With 30-80 concurrent agents that cap was a
// memory/scale tradeoff, and on any pane remount (page reload, project switch,
// backend-restart reattach) the restored history was just that ~200 KB of raw
// pty bytes — for a full-screen TUI, only a few screens. Persisting to disk
// lets us replay a much larger window (TERMINAL_CONFIG.SCROLLBACK_REPLAY_BYTES)
// while keeping per-session memory bounded to the small pending buffer.
//
// Reliability: every disk op is best-effort. If the filesystem is unavailable
// the store transparently DEGRADES to a bounded in-memory tail (the old
// behavior, just larger) so a terminal never breaks because scrollback
// couldn't be written.
//
// This module owns the pending-buffer/degraded-mode state machine; the
// low-level file-tail mechanics live in `scrollbackLogFile.ts` and the
// boot-time directory wipe in `scrollbackCleanup.ts`.

const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 40;
const COMPACT_RETRY_COOLDOWN_MS = 5_000;

export type ScrollbackStoreOptions = {
  // Directory the log file lives in. Defaults to the shared
  // ~/.lattice/terminal-scrollback. Overridable for tests.
  dir?: string;
  replayWindowBytes?: number;
  flushThresholdBytes?: number;
  maxDiskBytes?: number;
  compactKeepBytes?: number;
};

export class ScrollbackStore {
  private readonly filePath: string;
  private readonly replayWindowBytes: number;
  private readonly flushThresholdBytes: number;
  private readonly maxDiskBytes: number;
  private readonly compactKeepBytes: number;

  private pending: string[] = [];
  private pendingBytes = 0;
  private diskBytes = 0;
  private dirReady = false;
  // Set once any disk op fails: fall back to a bounded in-memory tail so the
  // terminal keeps replaying recent output instead of breaking.
  private degraded = false;
  private disposed = false;
  // The in-flight async compaction (see compact()). While it runs, flushes
  // are held in `pending` so no append lands between its read and its rename.
  private compaction: Promise<void> | null = null;
  // After a compaction whose rename failed (see compact()), don't retry before
  // this time: each attempt re-reads the kept tail, and a threshold-crossing
  // flush arrives every 64 KB.
  private compactNotBefore = 0;

  constructor(id: string, opts: ScrollbackStoreOptions = {}) {
    const dir = opts.dir ?? terminalScrollbackDir();
    this.filePath = path.join(dir, `${id}.log`);
    this.replayWindowBytes =
      opts.replayWindowBytes ?? TERMINAL_CONFIG.SCROLLBACK_REPLAY_BYTES;
    this.flushThresholdBytes =
      opts.flushThresholdBytes ?? TERMINAL_CONFIG.SCROLLBACK_FLUSH_BYTES;
    this.maxDiskBytes =
      opts.maxDiskBytes ?? TERMINAL_CONFIG.SCROLLBACK_MAX_DISK_BYTES;
    this.compactKeepBytes =
      opts.compactKeepBytes ?? TERMINAL_CONFIG.SCROLLBACK_KEEP_BYTES;
  }

  append(data: string): void {
    if (this.disposed || data.length === 0) return;
    this.pending.push(data);
    this.pendingBytes += Buffer.byteLength(data);
    if (this.degraded) {
      this.trimDegraded();
      return;
    }
    if (this.pendingBytes >= this.flushThresholdBytes) this.flush();
  }

  // The full replay window for a (re)attaching client — synchronous. Kept for
  // tests and as replayAsync's fallback; the attach path uses replayAsync so
  // an up-to-2 MB read never blocks the event loop every pty shares.
  replay(): string {
    if (this.disposed) return '';
    this.flush();
    if (this.degraded) return this.pending.join('');
    let tail: string;
    try {
      tail = readTail(this.filePath, this.replayWindowBytes).toString('utf8');
    } catch {
      // File missing (nothing was ever flushed) or a read error — nothing to
      // replay.
      tail = '';
    }
    // Output held back during a compaction is not on disk yet; it is the
    // newest output, so it follows the tail.
    return this.pending.length > 0 ? tail + this.pending.join('') : tail;
  }

  // The replay window AS OF THE MOMENT OF THE CALL, read off the event loop.
  // The snapshot (flushed length + held pending) is taken synchronously before
  // the first await, so output appended while the read is in flight is NOT in
  // the result: attachTerminal holds those bytes as live frames and delivers
  // them right after the replay, so nothing is duplicated or reordered.
  async replayAsync(): Promise<string> {
    if (this.disposed) return '';
    this.flush();
    if (this.degraded) return this.pending.join('');
    // A compaction already rewriting the log could land (rename + the flush of
    // the held pending) between our snapshot and our open, in which case the
    // file's tail would already contain the held output. Rare (once per
    // ~4 MB of output per session) — take the synchronous path, which is
    // consistent by construction.
    if (this.compaction) return this.replay();
    const heldTail = this.pending.join('');
    const end = this.diskBytes;
    // A compaction that starts AFTER this point cannot get ahead of the read:
    // its open/stat/read/write/rename are queued on the same FIFO thread pool
    // behind ours, and until our handle closes Windows refuses the rename
    // (retried by compact()) while POSIX keeps our handle on the old inode.
    let tail: string;
    try {
      tail = (await readTailAsync(this.filePath, this.replayWindowBytes, end)).toString('utf8');
    } catch {
      tail = '';
    }
    if (this.disposed) return '';
    return heldTail.length > 0 ? tail + heldTail : tail;
  }

  // Resolves once no compaction is in flight (and its post-compaction flush has
  // landed). Tests; nothing in the data path waits on it.
  async settle(): Promise<void> {
    while (this.compaction) await this.compaction;
  }

  // Approximate bytes retained (disk + not-yet-flushed). Debug only
  // (listSessions). Not exact under degraded mode.
  get size(): number {
    return this.diskBytes + this.pendingBytes;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* ignore */
    }
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    if (this.degraded) {
      this.trimDegraded();
      return;
    }
    // A compaction is rewriting the log: hold output in memory (bounded to the
    // replay window, which is all a replay ever shows) and flush it once the
    // rewrite has landed — an append between its read and its rename would be
    // lost.
    if (this.compaction) {
      this.trimDegraded();
      return;
    }
    const chunk = this.pending.join('');
    try {
      this.ensureDir();
      fs.appendFileSync(this.filePath, chunk);
      this.diskBytes += Buffer.byteLength(chunk);
      this.pending = [];
      this.pendingBytes = 0;
      if (this.diskBytes > this.maxDiskBytes && Date.now() >= this.compactNotBefore) {
        this.compaction = this.compact();
      }
    } catch {
      // Disk unavailable — degrade to a bounded in-memory tail (keep pending
      // so recent output still replays). Never throw out of the pty data path.
      this.degraded = true;
      this.trimDegraded();
    }
  }

  // Rewrite the log keeping only its most recent tail, so a long-lived noisy
  // terminal can't grow the file without bound. Kicked off by the flush that
  // crosses maxDiskBytes — i.e. roughly once per (maxDisk - keep) of output —
  // and runs ASYNCHRONOUSLY: the read-4-MB + write-4-MB it does used to run
  // synchronously on the terminal-server's event loop, which hosts every pty,
  // so thirty agents each crossing the cap froze all of them in turn. The
  // rewrite goes through a temp file + rename so a concurrent replay() sees
  // either the old log or the new one, never a half-written file.
  private async compact(): Promise<void> {
    const tmp = `${this.filePath}.compact`;
    try {
      const kept = await readTailAsync(this.filePath, this.compactKeepBytes);
      if (this.disposed) return;
      await fsp.writeFile(tmp, kept);
      if (this.disposed) return;
      // The rename runs on a worker thread, so on Windows it can land while a
      // concurrent replay() holds the log open for its synchronous readTail —
      // and Windows refuses to replace a file another handle has open (EPERM
      // / EBUSY, momentarily). That is not "disk unavailable": retry briefly,
      // and if it still fails leave the OLD log intact (it is complete, just
      // over the cap) rather than dropping to memory-only for the rest of the
      // session, and try again at the next crossing after a cooldown.
      let renamed = false;
      for (let attempt = 0; attempt < RENAME_ATTEMPTS && !this.disposed; attempt++) {
        try {
          await fsp.rename(tmp, this.filePath);
          renamed = true;
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
          await new Promise((r) => setTimeout(r, RENAME_RETRY_MS));
        }
      }
      if (renamed) this.diskBytes = kept.length;
      else this.compactNotBefore = Date.now() + COMPACT_RETRY_COOLDOWN_MS;
    } catch {
      if (!this.disposed) this.degraded = true;
    } finally {
      this.compaction = null;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (this.disposed) {
        // dispose() may have raced the rename above; make sure the log is gone.
        await fsp.rm(this.filePath, { force: true }).catch(() => {});
      } else {
        this.flush();
      }
    }
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.dirReady = true;
  }

  // Degraded fallback: keep only the last replayWindowBytes of pending in
  // memory (front-trim) so memory stays bounded without the on-disk log.
  private trimDegraded(): void {
    while (
      this.pendingBytes > this.replayWindowBytes &&
      this.pending.length > 1
    ) {
      const removed = this.pending.shift();
      if (removed) this.pendingBytes -= Buffer.byteLength(removed);
    }
  }
}
