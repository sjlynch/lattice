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
// Pure classifiers first (unit-tested on fixtures), then the IO wrapper; the
// file locators / tail reader it uses live in `sessionFiles.ts` (re-exported
// here so existing imports keep working).

import { claudeTranscriptPath } from './harnessPaths.js';
import {
  claudeSessionStatus,
  findClaudeConversationId,
  findCodexRolloutFile,
  findPiSessionFile,
  readTail,
  type BusyEvidence,
} from './sessionFiles.js';
import type { AgentSessionRef, TerminalRecord } from './types.js';

export {
  claudeSessionStatus,
  fileExists,
  findClaudeConversationId,
  findCodexRolloutFile,
  findPiSessionFile,
  lastConversationWrittenBy,
  listCodexDayDirs,
  readTail,
} from './sessionFiles.js';
export type { BusyEvidence };

export type TurnState = 'open' | 'idle' | 'unknown';
export type Interruption = 'interrupted' | 'idle' | 'unknown';

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


export type InterruptionVerdict = {
  interruption: Interruption;
  turn: TurnState;
  busy: BusyEvidence;
  // Claude only: whether the transcript file exists (drives resume vs fresh).
  transcriptExists?: boolean;
  // The conversation to relaunch into, when it is not the record's own
  // `agentSession` (Claude: the process switched conversation in its tab).
  agentSession?: AgentSessionRef;
};

function latticeBusyEvidence(record: TerminalRecord): BusyEvidence {
  if (!record.lastBusy) return 'unknown';
  return record.lastBusy.busy ? 'busy' : 'idle';
}

async function detectClaudeInterruption(record: TerminalRecord, session: AgentSessionRef): Promise<InterruptionVerdict> {
  // The pinned id names the PROCESS; the conversation it last wrote to may
  // be another one. Everything below reads that conversation's transcript.
  // Floor at the tab's CREATION, not its last relaunch: only this tab's
  // processes ever carry its pinned id, and the switch may have happened
  // several relaunches ago (each later one a fresh, never-used launch).
  const conversation = await findClaudeConversationId(record.cwd, session.id, record.createdAt) ?? session.id;
  const file = claudeTranscriptPath(record.cwd, conversation);
  const tail = await readTail(file);
  const turn = tail === null ? 'unknown' : classifyClaudeTranscriptTail(tail);
  // `~/.claude/sessions/<pid>.json` is keyed by the process's id.
  const native = await claudeSessionStatus(session.id);
  const busy = native !== 'unknown' ? native : latticeBusyEvidence(record);
  return {
    interruption: decideInterruption(turn, busy),
    turn,
    busy,
    transcriptExists: tail !== null,
    ...(conversation !== session.id
      ? { agentSession: { harness: 'claude', id: conversation, source: 'transcript-scan' } }
      : {}),
  };
}

async function detectPiInterruption(record: TerminalRecord, session: AgentSessionRef): Promise<InterruptionVerdict> {
  const file = await findPiSessionFile(record.cwd, session.id);
  const tail = file ? await readTail(file) : null;
  const turn = tail === null ? 'unknown' : classifyPiTranscriptTail(tail);
  const busy = latticeBusyEvidence(record);
  return { interruption: decideInterruption(turn, busy), turn, busy };
}

async function detectCodexInterruption(record: TerminalRecord, session: AgentSessionRef): Promise<InterruptionVerdict> {
  const file = await findCodexRolloutFile(session.id);
  const tail = file ? await readTail(file) : null;
  const turn = tail === null ? 'unknown' : classifyCodexRolloutTail(tail);
  const busy = latticeBusyEvidence(record);
  return { interruption: decideInterruption(turn, busy), turn, busy };
}

// Read whatever the harness left behind for this record and decide.
export async function detectInterruption(record: TerminalRecord): Promise<InterruptionVerdict> {
  const session = record.agentSession;
  if (!session) return { interruption: 'unknown', turn: 'unknown', busy: latticeBusyEvidence(record) };
  if (session.harness === 'claude') return detectClaudeInterruption(record, session);
  if (session.harness === 'pi') return detectPiInterruption(record, session);
  return detectCodexInterruption(record, session);
}
