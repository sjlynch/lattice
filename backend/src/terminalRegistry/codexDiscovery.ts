// Learn a Codex session's thread id after launch. Codex has no way to pre-set
// one (openai/codex#46672), but it writes
// `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` the moment a thread
// starts, with `{type:"session_meta", payload:{id, cwd, timestamp}}` on line 1.
// Matching on cwd + "started after our spawn" + "not claimed by another tab"
// is enough in practice; two Codex tabs launched in the same cwd within the
// window are assigned in timestamp order and flagged `ambiguous`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { codexSessionsDir, normalizeCwd } from './harnessPaths.js';
import { listCodexDayDirs } from './interruption.js';
import { terminalRegistry } from './store.js';
import type { TerminalRecord } from './types.js';

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
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
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
  const days = Math.min(120, Math.max(2, Math.ceil((Date.now() - createdSince) / 86_400_000) + 2));
  for (const { file, mtimeMs } of await listRolloutFilesShared(root, days)) {
    if (mtimeMs < writtenSince - 60_000) continue;
    const meta = await rolloutMeta(file);
    if (meta && meta.timestamp >= createdSince - 5_000) out.push({ ...meta, mtimeMs });
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

export type CodexDiscoveryResult = { id: string; ambiguous: boolean };

// How long after the tab's launch its Codex process can have started. The
// rollout's `session_meta.timestamp` is the PROCESS start, even though the file
// itself is only written on the first turn — so it pins a fresh thread to the
// launch that made it. Without this bound, a Codex tab left idle past the old
// 2-minute poll could claim the thread of a Codex tab opened later in the same
// folder that was typed into first. Generous for a slow cold start on Windows.
export const CODEX_FRESH_START_WINDOW_MS = 2 * 60_000;

// A fresh launch is the EARLIEST unclaimed thread started after the tab (Codex
// created it for us). A relaunch via `codex resume --last` reopened the thread
// most recently written in that cwd, so there the pick is the NEWEST by mtime
// — the file being appended right now — never the oldest.
export function pickCodexSession(
  candidates: CodexRolloutMeta[],
  cwd: string,
  claimed: ReadonlySet<string>,
  mode: 'fresh' | 'resumed' = 'fresh',
  // Fresh mode only: the tab's launch time; threads started more than
  // CODEX_FRESH_START_WINDOW_MS after it belong to a later launch.
  launchedAt?: number,
): CodexDiscoveryResult | null {
  const want = normalizeCwd(cwd);
  const matches = candidates.filter((c) => normalizeCwd(c.cwd) === want && !claimed.has(c.id)
    && (mode !== 'fresh' || launchedAt === undefined || c.timestamp <= launchedAt + CODEX_FRESH_START_WINDOW_MS));
  if (matches.length === 0) return null;
  if (mode === 'resumed') {
    const newest = [...matches].sort((a, b) => (b.mtimeMs ?? b.timestamp) - (a.mtimeMs ?? a.timestamp))[0]!;
    return { id: newest.id, ambiguous: matches.length > 1 };
  }
  return { id: matches[0]!.id, ambiguous: matches.length > 1 };
}

function claimedCodexIds(): Set<string> {
  const set = new Set<string>();
  for (const { record } of terminalRegistry.loadedRecords()) {
    if (record.agentSession?.harness === 'codex') set.add(record.agentSession.id);
  }
  return set;
}

// One discovery attempt for a record. Returns true once the id is known.
export async function discoverCodexSessionFor(recordId: string, projectPath: string): Promise<boolean> {
  const record = await terminalRegistry.get(recordId, projectPath);
  if (!record || record.ended) return true; // nothing left to do
  if (record.agentSession?.harness === 'codex') return true;
  // Ordinary relaunches keep the tab's creation floor. Orphan adoption
  // replaces that provenance: a fresh process has a new start window, while
  // a resumed process may append to a thread older than this tab.
  const discovery: NonNullable<TerminalRecord['codexDiscovery']> = record.codexDiscovery ?? {
    createdSince: record.createdAt,
    writtenSince: record.restoredAt ?? record.createdAt,
    mode: record.restoredAt !== undefined ? 'resumed' : 'fresh',
  };
  const candidates = await scanRecentCodexRollouts(discovery.createdSince, undefined, discovery.writtenSince);
  // The scan awaits disk I/O. An adoption / relaunch meanwhile invalidates
  // its evidence; don't put the dead pty's identity back onto its replacement.
  const current = await terminalRegistry.get(recordId, projectPath);
  if (!current || current.ended || current.agentSession?.harness === 'codex') return true;
  if (current.serverId !== record.serverId || current.serverInstanceId !== record.serverInstanceId
    || current.codexDiscovery !== record.codexDiscovery || current.restoredAt !== record.restoredAt) return false;
  const pick = pickCodexSession(
    candidates, record.cwd, claimedCodexIds(), discovery.mode, discovery.createdSince,
  );
  if (!pick) return false;
  await terminalRegistry.update(record.id, {
    agentSession: {
      harness: 'codex',
      id: pick.id,
      source: 'rollout-scan',
      ...(pick.ambiguous ? { ambiguous: true } : {}),
    },
  }, projectPath);
  return true;
}

// Codex writes its rollout on the FIRST TURN, not at launch — a tab you open
// and type into three minutes later has no file for three minutes (measured:
// session start 13:11:07, rollout written 13:13:49). A fixed 2-minute window
// gave up on exactly those tabs, and their restore fell back to
// `resume --last`. So poll until the id is known or the record ends
// (`discoverCodexSessionFor` answers true for both), backing off as the tab
// ages: every 2 s for the first 2 min, 15 s up to 30 min, then once a minute.
// The listing each tick shares is cached (`listRolloutFilesShared`), so a slow
// tail costs almost nothing.
const DISCOVERY_BACKOFF: ReadonlyArray<{ untilMs: number; intervalMs: number }> = [
  { untilMs: 2 * 60_000, intervalMs: 2_000 },
  { untilMs: 30 * 60_000, intervalMs: 15_000 },
  { untilMs: Infinity, intervalMs: 60_000 },
];
// Backstop for a record that is never ended (a leak elsewhere): stop after a day.
const DISCOVERY_MAX_MS = 24 * 60 * 60_000;
const inFlight = new Set<string>();

export function discoveryIntervalMs(elapsedMs: number): number {
  return DISCOVERY_BACKOFF.find((s) => elapsedMs < s.untilMs)!.intervalMs;
}

// Poll for the rollout file until it appears or the record ends.
export function scheduleCodexDiscovery(
  recordId: string,
  projectPath: string,
  opts: { intervalMs?: number; windowMs?: number } = {},
): void {
  if (inFlight.has(recordId)) return;
  inFlight.add(recordId);
  const startedAt = Date.now();
  const nextInterval = () => opts.intervalMs ?? discoveryIntervalMs(Date.now() - startedAt);
  const deadline = startedAt + (opts.windowMs ?? DISCOVERY_MAX_MS);
  const tick = async () => {
    let done = false;
    try { done = await discoverCodexSessionFor(recordId, projectPath); } catch { /* retry */ }
    if (done || Date.now() > deadline) {
      inFlight.delete(recordId);
      return;
    }
    const t = setTimeout(() => { void tick(); }, nextInterval());
    t.unref?.();
  };
  const first = setTimeout(() => { void tick(); }, nextInterval());
  first.unref?.();
}
