// "Was this agent mid-turn when its pty died?" — decides whether a relaunched
// USER tab gets the continue-nudge. Two independent evidence sources; any
// `idle` evidence vetoes, and a nudge needs positive transcript evidence, so
// the rule is biased against the one bad outcome (saying "continue" to a
// session that was quietly waiting for the user).
//
//   1. Transcript tail (harness-native, deterministic, survives a reboot):
//      claude  last assistant entry ends in a tool_use with no tool_result →
//              open; a trailing user prompt with no reply → open; a user
//              entry that is the `[Request interrupted by user…]` marker → idle
//      pi      last message: assistant stopReason "toolUse" / a trailing user
//              or toolResult message → open; stopReason "stop" → idle
//      codex   `task_started` after the last `task_complete`/`turn_aborted` → open
//   2. Busy-at-death record: Claude's own `~/.claude/sessions/<pid>.json`
//      status (survives a crash until the next launch cleans it), otherwise
//      Lattice's persisted `lastBusy` transition (≤ ~2 s stale).
//
// Pure classifiers first (unit-tested on fixtures), then the IO wrapper.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  claudeSessionsDir,
  claudeTranscriptPath,
  codexSessionsDir,
  piSessionsDir,
} from './harnessPaths.js';
import type { TerminalRecord } from './types.js';

export type TurnState = 'open' | 'idle' | 'unknown';
export type BusyEvidence = 'busy' | 'idle' | 'unknown';
export type Interruption = 'interrupted' | 'idle' | 'unknown';

const TAIL_BYTES = 256 * 1024;

function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* partial first line of a tail read */ }
  }
  return out;
}

type ClaudeContentBlock = { type?: string; text?: string };

function claudeBlocks(entry: Record<string, unknown>): ClaudeContentBlock[] {
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

export function classifyClaudeTranscriptTail(text: string): TurnState {
  const entries = parseLines(text) as Array<Record<string, unknown>>;
  let last: Record<string, unknown> | null = null;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    // Sidechain (subagent) entries live in their own files but are guarded
    // anyway; `isMeta` entries are bookkeeping, not conversation.
    if (e.isSidechain === true || e.isMeta === true) continue;
    if (e.type === 'user' || e.type === 'assistant') last = e;
  }
  if (!last) return 'unknown';
  const blocks = claudeBlocks(last);
  if (last.type === 'assistant') {
    return blocks.some((b) => b.type === 'tool_use') ? 'open' : 'idle';
  }
  // A user entry with no assistant reply after it.
  if (blocks.some((b) => b.type === 'tool_result')) return 'open';
  const text_ = blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
  if (/\[Request interrupted by user/i.test(text_)) return 'idle';
  return 'open';
}

export function classifyPiTranscriptTail(text: string): TurnState {
  const entries = parseLines(text) as Array<Record<string, unknown>>;
  let last: Record<string, unknown> | null = null;
  for (const e of entries) {
    if (e && typeof e === 'object' && e.type === 'message' && e.message && typeof e.message === 'object') {
      last = e.message as Record<string, unknown>;
    }
  }
  if (!last) return 'unknown';
  const role = last.role;
  if (role === 'assistant') {
    const stop = last.stopReason;
    if (stop === 'toolUse') return 'open';
    if (stop === 'stop' || stop === 'length' || stop === 'aborted' || stop === 'error') return 'idle';
    return 'unknown';
  }
  if (role === 'user' || role === 'toolResult') return 'open';
  return 'unknown';
}

export function classifyCodexRolloutTail(text: string): TurnState {
  const entries = parseLines(text) as Array<Record<string, unknown>>;
  let state: TurnState = 'unknown';
  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.type !== 'event_msg') continue;
    const payload = e.payload as Record<string, unknown> | undefined;
    const t = payload?.type;
    if (t === 'task_started') state = 'open';
    else if (t === 'task_complete' || t === 'turn_aborted' || t === 'task_aborted') state = 'idle';
  }
  return state;
}

// The decision: nudge-worthy only with positive transcript evidence AND no
// idle veto from the busy record.
export function decideInterruption(turn: TurnState, busy: BusyEvidence): Interruption {
  if (turn === 'open' && busy !== 'idle') return 'interrupted';
  if (turn === 'idle' || busy === 'idle') return 'idle';
  return 'unknown';
}

export async function readTail(file: string, maxBytes = TAIL_BYTES): Promise<string | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch { return false; }
}

// `~/.claude/sessions/<pid>.json` → the `status` recorded for `sessionId`,
// newest `statusUpdatedAt` wins when several pids share the id.
export async function claudeSessionStatus(sessionId: string): Promise<BusyEvidence> {
  const dir = claudeSessionsDir();
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return 'unknown'; }
  let best: { at: number; status: string } | null = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Record<string, unknown>;
      if (raw.sessionId !== sessionId || typeof raw.status !== 'string') continue;
      const at = typeof raw.statusUpdatedAt === 'number' ? raw.statusUpdatedAt : 0;
      if (!best || at > best.at) best = { at, status: raw.status };
    } catch { /* unreadable / mid-write */ }
  }
  if (!best) return 'unknown';
  return best.status === 'busy' ? 'busy' : best.status === 'idle' ? 'idle' : 'unknown';
}

export async function findPiSessionFile(cwd: string, sessionId: string): Promise<string | null> {
  const dir = piSessionsDir(cwd);
  const suffix = `_${encodeURIComponent(sessionId)}.jsonl`;
  try {
    const names = await fs.readdir(dir);
    const match = names.filter((n) => n.endsWith(suffix)).sort().pop();
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

// Newest-first walk of `~/.codex/sessions/YYYY/MM/DD/` for `rollout-*-<id>.jsonl`
// (Codex rewrites week-old rollouts as `.jsonl.zst`, which we cannot read —
// those come back null, i.e. unknown).
export async function findCodexRolloutFile(sessionId: string, maxDays = 30): Promise<string | null> {
  const root = codexSessionsDir();
  const dayDirs = await listCodexDayDirs(root, maxDays);
  for (const dir of dayDirs) {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { continue; }
    const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(`-${sessionId}.jsonl`));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

// Day directories, newest first, bounded to the most recent `maxDays`.
export async function listCodexDayDirs(root: string, maxDays: number): Promise<string[]> {
  const out: string[] = [];
  let years: string[];
  try { years = (await fs.readdir(root)).filter((y) => /^\d{4}$/.test(y)).sort().reverse(); } catch { return out; }
  for (const y of years) {
    let months: string[];
    try { months = (await fs.readdir(path.join(root, y))).filter((m) => /^\d{2}$/.test(m)).sort().reverse(); } catch { continue; }
    for (const m of months) {
      let days: string[];
      try { days = (await fs.readdir(path.join(root, y, m))).filter((d) => /^\d{2}$/.test(d)).sort().reverse(); } catch { continue; }
      for (const d of days) {
        out.push(path.join(root, y, m, d));
        if (out.length >= maxDays) return out;
      }
    }
  }
  return out;
}

export type InterruptionVerdict = {
  interruption: Interruption;
  turn: TurnState;
  busy: BusyEvidence;
  // Claude only: whether the transcript file exists (drives resume vs fresh).
  transcriptExists?: boolean;
};

function latticeBusyEvidence(record: TerminalRecord): BusyEvidence {
  if (!record.lastBusy) return 'unknown';
  return record.lastBusy.busy ? 'busy' : 'idle';
}

// Read whatever the harness left behind for this record and decide.
export async function detectInterruption(record: TerminalRecord): Promise<InterruptionVerdict> {
  const session = record.agentSession;
  if (!session) return { interruption: 'unknown', turn: 'unknown', busy: latticeBusyEvidence(record) };
  if (session.harness === 'claude') {
    const file = claudeTranscriptPath(record.cwd, session.id);
    const tail = await readTail(file);
    const turn = tail === null ? 'unknown' : classifyClaudeTranscriptTail(tail);
    const native = await claudeSessionStatus(session.id);
    const busy = native !== 'unknown' ? native : latticeBusyEvidence(record);
    return { interruption: decideInterruption(turn, busy), turn, busy, transcriptExists: tail !== null };
  }
  if (session.harness === 'pi') {
    const file = await findPiSessionFile(record.cwd, session.id);
    const tail = file ? await readTail(file) : null;
    const turn = tail === null ? 'unknown' : classifyPiTranscriptTail(tail);
    const busy = latticeBusyEvidence(record);
    return { interruption: decideInterruption(turn, busy), turn, busy };
  }
  const file = await findCodexRolloutFile(session.id);
  const tail = file ? await readTail(file) : null;
  const turn = tail === null ? 'unknown' : classifyCodexRolloutTail(tail);
  const busy = latticeBusyEvidence(record);
  return { interruption: decideInterruption(turn, busy), turn, busy };
}
