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
  // Bounded so an ancient tab cannot turn each poll into a walk of years of
  // rollouts; the stat pre-filter keeps the per-file cost to one stat.
  const days = Math.min(120, Math.max(2, Math.ceil((Date.now() - createdSince) / 86_400_000) + 2));
  for (const dir of await listCodexDayDirs(root, days)) {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(file)).mtimeMs;
        if (mtimeMs < writtenSince - 60_000) continue;
      } catch { continue; }
      const line = await readFirstLine(file);
      const meta = line ? parseCodexSessionMeta(line, file) : null;
      if (meta && meta.timestamp >= createdSince - 5_000) out.push({ ...meta, mtimeMs });
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export type CodexDiscoveryResult = { id: string; ambiguous: boolean };

// A fresh launch is the EARLIEST unclaimed thread started after the tab (Codex
// created it for us). A relaunch via `codex resume --last` reopened the thread
// most recently written in that cwd, so there the pick is the NEWEST by mtime
// — the file being appended right now — never the oldest.
export function pickCodexSession(
  candidates: CodexRolloutMeta[],
  cwd: string,
  claimed: ReadonlySet<string>,
  mode: 'fresh' | 'resumed' = 'fresh',
): CodexDiscoveryResult | null {
  const want = normalizeCwd(cwd);
  const matches = candidates.filter((c) => normalizeCwd(c.cwd) === want && !claimed.has(c.id));
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
  // The thread this tab runs was created no earlier than the tab itself —
  // even after a `codex resume --last` relaunch, which reopens an older file
  // (but writes to it now, hence the mtime bound at the relaunch time).
  const resumed = record.restoredAt !== undefined;
  const candidates = await scanRecentCodexRollouts(record.createdAt, undefined, record.restoredAt ?? record.createdAt);
  const pick = pickCodexSession(candidates, record.cwd, claimedCodexIds(), resumed ? 'resumed' : 'fresh');
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

const DISCOVERY_INTERVAL_MS = 2_000;
const DISCOVERY_WINDOW_MS = 120_000;
const inFlight = new Set<string>();

// Poll for the rollout file until it appears (a Codex TUI writes it within a
// second or two of starting; the window is generous for a slow first launch).
export function scheduleCodexDiscovery(
  recordId: string,
  projectPath: string,
  opts: { intervalMs?: number; windowMs?: number } = {},
): void {
  if (inFlight.has(recordId)) return;
  inFlight.add(recordId);
  const interval = opts.intervalMs ?? DISCOVERY_INTERVAL_MS;
  const deadline = Date.now() + (opts.windowMs ?? DISCOVERY_WINDOW_MS);
  const tick = async () => {
    let done = false;
    try { done = await discoverCodexSessionFor(recordId, projectPath); } catch { /* retry */ }
    if (done || Date.now() > deadline) {
      inFlight.delete(recordId);
      return;
    }
    const t = setTimeout(() => { void tick(); }, interval);
    t.unref?.();
  };
  const first = setTimeout(() => { void tick(); }, interval);
  first.unref?.();
}
