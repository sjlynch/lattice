// Read Codex rollout metadata with bounded IO and process-wide shared caches.
// Candidate selection, registry writes and polling live in codexDiscovery.ts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { codexSessionsDir } from './harnessPaths.js';
import { listCodexDayDirs } from './sessionFiles.js';

const FIRST_LINE_CHUNK_BYTES = 8_192;
const MAX_FIRST_LINE_BYTES = 256 * 1024;
const MAX_SCAN_DAYS = 120;
const MIN_SCAN_DAYS = 2;
const SCAN_PADDING_DAYS = 2;
const DAY_MS = 86_400_000;
const MTIME_ALLOWANCE_MS = 60_000;
const CREATION_TIME_ALLOWANCE_MS = 5_000;

export type CodexRolloutMeta = { id: string; cwd: string; timestamp: number; file: string; mtimeMs?: number };

export function parseCodexSessionMeta(firstLine: string, file: string): CodexRolloutMeta | null {
  try {
    const raw = JSON.parse(firstLine) as Record<string, unknown>;
    if (raw.type !== 'session_meta') return null;
    const payload = raw.payload as Record<string, unknown> | undefined;
    const id = typeof payload?.id === 'string' ? payload.id : typeof payload?.session_id === 'string' ? payload.session_id : null;
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;
    const ts = typeof payload?.timestamp === 'string' ? Date.parse(payload.timestamp)
      : typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
    if (!id || !cwd || !Number.isFinite(ts)) return null;
    return { id, cwd, timestamp: ts, file };
  } catch {
    return null;
  }
}

async function readFirstLine(file: string): Promise<string | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r');
    // Recent Codex session_meta rows also carry base_instructions. A single
    // 8 KB read truncated those rows (23 KB observed in 0.159), so JSON.parse
    // failed on every discovery poll and the conversation was never pinned.
    // Read only through the first newline, with a hard bound on total IO.
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < MAX_FIRST_LINE_BYTES) {
      const buf = Buffer.alloc(Math.min(FIRST_LINE_CHUNK_BYTES, MAX_FIRST_LINE_BYTES - offset));
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) return Buffer.concat(chunks).toString('utf8');
      const bytes = buf.subarray(0, bytesRead);
      const newline = bytes.indexOf(10);
      chunks.push(newline >= 0 ? bytes.subarray(0, newline) : bytes);
      if (newline >= 0) return Buffer.concat(chunks).toString('utf8');
      offset += bytesRead;
    }
    return null; // oversized or still-incomplete metadata; no partial identity
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Every rollout whose thread started at/after `createdSince` (minus a small
// clock-skew allowance) AND whose file was written at/after `writtenSince`,
// scanning as many day-directories back as `createdSince` reaches. The two
// bounds differ for a relaunched tab: `codex resume` appends to the thread's
// ORIGINAL rollout, whose `session_meta` timestamp is the thread's creation
// (≥ the tab's createdAt), while the file's mtime is now (≥ the relaunch) —
// the cheap stat pre-filter keys on the latter so an old tab does not read
// every rollout of the last month on each poll.
export async function scanRecentCodexRollouts(
  createdSince: number,
  root = codexSessionsDir(),
  writtenSince = createdSince,
): Promise<CodexRolloutMeta[]> {
  const out: CodexRolloutMeta[] = [];
  // The day window follows the thread's CREATION (≥ the tab's createdAt), not
  // the relaunch time: a rollout lives in the day-directory of the day its
  // thread started, and `codex resume` appends to that same old file. Bounded
  // so an ancient tab cannot turn each poll into a walk of years of rollouts.
  const days = Math.min(MAX_SCAN_DAYS, Math.max(MIN_SCAN_DAYS, Math.ceil((Date.now() - createdSince) / DAY_MS) + SCAN_PADDING_DAYS));
  for (const { file, mtimeMs } of await listRolloutFilesShared(root, days)) {
    if (mtimeMs < writtenSince - MTIME_ALLOWANCE_MS) continue;
    const meta = await rolloutMeta(file);
    if (meta && meta.timestamp >= createdSince - CREATION_TIME_ALLOWANCE_MS) out.push({ ...meta, mtimeMs });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

// ---- shared scan state ------------------------------------------------------
//
// Restore relaunches N Codex tabs in parallel and each polls discovery every
// 2 s for up to 2 min; every poll used to readdir + stat the whole window on
// its own (10 tabs × ~1,000 rollouts × 60 ticks ≈ 600k stats competing with the
// health watcher for the thread pool). Two caches collapse that:
//   - the directory listing + stats are taken ONCE per `(root, days)` per
//     short TTL and shared by every in-flight discovery (single-flighted);
//   - a rollout's `session_meta` line never changes once written, so a parsed
//     meta is kept for the process lifetime and the file is never re-read.

const LISTING_TTL_MS = 1_500;
type RolloutListing = Array<{ file: string; mtimeMs: number }>;
const listings = new Map<string, { at: number; value: Promise<RolloutListing> }>();

async function listRolloutFiles(root: string, days: number): Promise<RolloutListing> {
  const out: RolloutListing = [];
  for (const dir of await listCodexDayDirs(root, days)) {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        out.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs });
      } catch { /* vanished between readdir and stat */ }
    }
  }
  return out;
}

export function listRolloutFilesShared(
  root: string,
  days: number,
  opts: { ttlMs?: number; now?: () => number; list?: typeof listRolloutFiles } = {},
): Promise<RolloutListing> {
  const now = opts.now ?? Date.now;
  const key = `${root}\0${days}`;
  const cached = listings.get(key);
  if (cached && now() - cached.at < (opts.ttlMs ?? LISTING_TTL_MS)) return cached.value;
  const value = (opts.list ?? listRolloutFiles)(root, days);
  listings.set(key, { at: now(), value });
  // A failed listing must not be served for the TTL; drop it so the next
  // caller re-lists.
  value.catch(() => { if (listings.get(key)?.value === value) listings.delete(key); });
  return value;
}

const META_CACHE_MAX = 4_096;
const metaCache = new Map<string, CodexRolloutMeta>();

async function rolloutMeta(file: string): Promise<CodexRolloutMeta | null> {
  const cached = metaCache.get(file);
  if (cached) return cached;
  const line = await readFirstLine(file);
  const meta = line ? parseCodexSessionMeta(line, file) : null;
  // Only a parsed meta is cached: an empty / half-written first line (the TUI
  // is still creating the file) must be re-read on the next tick.
  if (meta) {
    if (metaCache.size >= META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value!);
    metaCache.set(file, meta);
  }
  return meta;
}

// Test seam.
export function resetCodexDiscoveryCaches(): void {
  listings.clear();
  metaCache.clear();
}
