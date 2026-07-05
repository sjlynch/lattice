import fs from 'node:fs';
import path from 'node:path';
import { terminalScrollbackDir } from '../projectPath.js';
import { TERMINAL_CONFIG } from '../terminalConfig.js';
import { readTail } from './scrollbackLogFile.js';

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

  // The full replay window for a (re)attaching client.
  replay(): string {
    if (this.disposed) return '';
    this.flush();
    if (this.degraded) return this.pending.join('');
    try {
      return readTail(this.filePath, this.replayWindowBytes).toString('utf8');
    } catch {
      // File missing (nothing was ever flushed) or a read error — nothing to
      // replay.
      return '';
    }
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
    const chunk = this.pending.join('');
    try {
      this.ensureDir();
      fs.appendFileSync(this.filePath, chunk);
      this.diskBytes += Buffer.byteLength(chunk);
      this.pending = [];
      this.pendingBytes = 0;
      if (this.diskBytes > this.maxDiskBytes) this.compact();
    } catch {
      // Disk unavailable — degrade to a bounded in-memory tail (keep pending
      // so recent output still replays). Never throw out of the pty data path.
      this.degraded = true;
      this.trimDegraded();
    }
  }

  // Rewrite the log keeping only its most recent tail, so a long-lived noisy
  // terminal can't grow the file without bound. Runs inline on a flush that
  // crosses maxDiskBytes — i.e. roughly once per (maxDisk - keep) of output.
  private compact(): void {
    try {
      const kept = readTail(this.filePath, this.compactKeepBytes);
      fs.writeFileSync(this.filePath, kept);
      this.diskBytes = kept.length;
    } catch {
      this.degraded = true;
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
