import type { RawData } from 'ws';
import { normalizeCwd } from '../terminalRegistry/harnessPaths.js';
import { proxyListSessionsShared } from '../terminalServerClient.js';
import { OUTBOX_MAX_AGE_MS, OUTBOX_REPLAY_HEADER } from './drain.js';

// Freshness guard for a REPLAYED task `/complete` (see drain.ts).
//
// A replay deliberately lands late: the hook gave up while the backend was
// down, and the drain posts the callback once it is back. By then the terminal
// WS works again, so the user may already have typed a new instruction into
// the idle agent — and a stale `/complete` would flip the task to
// ready_to_merge and kill its pty in the middle of that new turn. So the drain
// stamps each replay with when the Stop actually happened
// (drain.ts `OUTBOX_REPLAY_HEADER` = the entry's `createdAt`), and `/complete` refuses
// the replay when the task's session shows activity after that instant:
//   - an activity-hook POST for the task (PreToolUse/PostToolUse/Subagent*,
//     from Claude, Codex or the Pi activity extension) — the agent is in a
//     turn;
//   - a line submitted (Enter) into a pty running in the task's worktree —
//     the user started one.
// A refused replay costs nothing: the new turn ends in its own Stop, which
// delivers (or queues) a fresh callback.
//
// Both stamps are in-memory. That is enough: activity that happened while the
// backend was down never reached it, and everything that could make a replay
// stale happens after the backend is back — i.e. in this process.

// An activity-hook POST the backend handles a moment after the Stop (a
// PostToolUse curl that was still in flight) belongs to the turn that ended,
// not to a new one.
const HOOK_ACTIVITY_GRACE_MS = 3_000;
// Stamps older than the drain's age cap can't matter; pruned past this size.
const PRUNE_ABOVE = 512;
// A keystroke frame is tiny; anything bigger is a paste, which doesn't submit.
const MAX_SUBMIT_FRAME_BYTES = 4096;

const taskHookActivityAt = new Map<string, number>();
const promptSubmitAt = new Map<string, number>();

function stamp(map: Map<string, number>, key: string, at: number): void {
  if (!key) return;
  map.set(key, at);
  if (map.size <= PRUNE_ABOVE) return;
  for (const [k, t] of map) {
    if (at - t > OUTBOX_MAX_AGE_MS) map.delete(k);
  }
}

// The task's agent reported tool / subagent activity (`/api/tasks/:id/activity`).
export function noteTaskAgentActivity(taskId: string, at: number = Date.now()): void {
  stamp(taskHookActivityAt, taskId, at);
}

// The browser submitted a line into pty `sessionId` (terminalWsRelay.ts).
export function noteTerminalPromptSubmit(sessionId: string, at: number = Date.now()): void {
  stamp(promptSubmitAt, sessionId, at);
}

// Is this browser→pty frame a submitted line? The terminal pane sends typed
// input as `{"type":"input","data":…}` (resizes etc. are other types); Enter is
// a `\r` in `data`.
export function isTerminalSubmitFrame(data: RawData, isBinary: boolean): boolean {
  if (isBinary || !Buffer.isBuffer(data) || data.length > MAX_SUBMIT_FRAME_BYTES) return false;
  if (!data.includes('"input"')) return false;
  try {
    const frame = JSON.parse(data.toString('utf8')) as { type?: unknown; data?: unknown };
    return frame.type === 'input' && typeof frame.data === 'string' && /[\r\n]/.test(frame.data);
  } catch {
    return false;
  }
}

// The Stop time a replayed callback carries, or null for a live callback.
export function outboxReplayQueuedAt(req: { headers?: Record<string, unknown> }): number | null {
  const raw = req.headers?.[OUTBOX_REPLAY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type ReplayStaleReason = 'agent-activity' | 'prompt-submitted';

type SessionLister = () => Promise<unknown[] | null>;

// Why a replay queued at `since` is stale for this task, or null when it is
// still the latest word. "Can't tell" (terminal-server unreachable) is null:
// the guard only ever refuses on positive evidence.
export async function taskSessionActiveSince(
  task: { id: string; worktreePath?: string | null },
  since: number,
  listSessions: SessionLister = () => proxyListSessionsShared(),
): Promise<ReplayStaleReason | null> {
  const hookAt = taskHookActivityAt.get(task.id);
  if (hookAt !== undefined && hookAt > since + HOOK_ACTIVITY_GRACE_MS) return 'agent-activity';

  if (!task.worktreePath) return null;
  let anyLater = false;
  for (const at of promptSubmitAt.values()) {
    if (at > since) {
      anyLater = true;
      break;
    }
  }
  if (!anyLater) return null;
  const sessions = await listSessions().catch(() => null);
  if (!sessions) return null;
  const root = normalizeCwd(task.worktreePath);
  for (const raw of sessions) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as { id?: unknown; cwd?: unknown };
    if (typeof s.id !== 'string' || typeof s.cwd !== 'string') continue;
    const cwd = normalizeCwd(s.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    const at = promptSubmitAt.get(s.id);
    if (at !== undefined && at > since) return 'prompt-submitted';
  }
  return null;
}

// Test seam.
export function resetReplayGuardForTest(): void {
  taskHookActivityAt.clear();
  promptSubmitAt.clear();
}
