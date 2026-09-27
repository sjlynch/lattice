// Locating and reading what each harness leaves on disk for a session: the
// transcript / rollout files, Claude's per-process status records, and the
// Codex day-directory walk. IO only — the "was it mid-turn?" verdict built on
// top of these lives in `interruption.ts`; Codex discovery reuses the walk.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  claudeSessionsDir,
  claudeTranscriptPath,
  codexSessionsDir,
  piSessionsDir,
} from './harnessPaths.js';

export type BusyEvidence = 'busy' | 'idle' | 'unknown';

const TAIL_BYTES = 256 * 1024;

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

// Interactive Claude stamps every transcript line with two ids: `sessionId`,
// the conversation (= the file name), and `session_id`, the PROCESS that wrote
// it (= the id Lattice pinned with `--session-id`). They match until the user
// switches conversation inside the tab (`/resume`): from then on the process
// appends to the other conversation's file, and the pinned id's own file may
// never exist at all — a relaunch built from the pinned id alone then opened a
// blank conversation (tab "claude! 2", 2026-09-24).
//
// Pure: the conversation the LAST line written by `processId` belongs to.
export function lastConversationWrittenBy(text: string, processId: string): string | null {
  const needle = new RegExp(`"session_id"\s*:\s*"${processId.replace(/[^A-Za-z0-9-]/g, '')}"`);
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!needle.test(line)) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.session_id === processId && typeof entry.sessionId === 'string') return entry.sessionId;
    } catch { /* partial first line of a tail read */ }
  }
  return null;
}

// Slack on the mtime floor below: a transcript written in the seconds around
// the launch still counts.
const CLAUDE_SCAN_SLACK_MS = 60_000;

// Which conversation did the Claude process pinned as `processId` write to
// last? Scans the cwd's transcripts modified since the process was launched
// (`sinceMs`), newest first, and reads each tail for a line it wrote. Null when
// none did (it never reached a turn, or wrote nothing since `sinceMs`).
export async function findClaudeConversationId(
  cwd: string,
  processId: string,
  sinceMs: number,
): Promise<string | null> {
  const dir = path.dirname(claudeTranscriptPath(cwd, processId));
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return null; }
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (st.isFile() && st.mtimeMs >= sinceMs - CLAUDE_SCAN_SLACK_MS) candidates.push({ file, mtimeMs: st.mtimeMs });
    } catch { /* vanished mid-scan */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    const tail = await readTail(c.file);
    const id = tail === null ? null : lastConversationWrittenBy(tail, processId);
    if (id) return id;
  }
  return null;
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
