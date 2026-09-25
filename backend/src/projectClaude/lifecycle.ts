import {
  registerAgentSession,
  touchAgentSession,
  unregisterAgentSession,
} from '../agentSessions.js';
import type { AgentHarness } from '../harnesses.js';

// Presence for a project session (an agent in a terminal the user opened —
// Claude via the project's `.claude/settings.local.json` hooks, Codex via its
// per-launch hook overrides, Pi via the project-root activity extension).
//
// The node means "this agent is WORKING", not "this terminal is open": it
// appears on the first sign of a turn (UserPromptSubmit, a tool use, a
// subagent event) and is removed shortly after the turn ends (Stop). A session
// merely sitting at its prompt draws nothing. That is what fixes the two
// "stuck node" symptoms: an agent that finished its turn used to keep its node
// and its last-file label on screen for as long as the terminal stayed open,
// and SessionStart put a bare dot on the graph the moment a tab was opened,
// before the agent had done anything.

// The graph node key for a project session. One namespace for every harness:
// the session id alone is unique (a Claude/Pi pinned id, a Codex thread id).
export function projectSessionAgentId(sessionId: string): string {
  return `claude:${sessionId}`;
}

// A project session that goes quiet for this long is dropped — a safety net
// for a session that dies mid-turn without firing Stop or SessionEnd (a
// hard-killed terminal the registry didn't see end). Generous, since a single
// long reasoning step can go minutes without a hook.
export const PROJECT_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;

// How long after a turn's Stop the node lingers before it is removed. Claude
// fires Stop early (and repeatedly) around subagents, whose tool use keeps
// arriving afterwards; any activity inside the window cancels the removal, so
// those turns don't flicker. Long enough to read the final file label.
export const TURN_END_GRACE_MS = 15 * 1000;

// After a session's SessionEnd we briefly remember its session_id so a hook
// that arrives AFTER SessionEnd can't resurrect the node. Each hook is an
// independent `curl -m 2` with no ordering guarantee, so a final PostToolUse
// can land after SessionEnd; the curl gives up after 2s, so any straggler
// arrives well within this window.
const RECENTLY_ENDED_TTL_MS = 30 * 1000;
const recentlyEndedAt = new Map<string, number>();

function rememberEndedSession(sessionId: string): void {
  const now = Date.now();
  recentlyEndedAt.set(sessionId, now);
  // Prune expired ids so the map stays bounded to recent session churn.
  for (const [id, ts] of recentlyEndedAt) {
    if (now - ts > RECENTLY_ENDED_TTL_MS) recentlyEndedAt.delete(id);
  }
}

function recentlyEnded(sessionId: string): boolean {
  const ts = recentlyEndedAt.get(sessionId);
  if (ts === undefined) return false;
  if (Date.now() - ts > RECENTLY_ENDED_TTL_MS) {
    recentlyEndedAt.delete(sessionId);
    return false;
  }
  return true;
}

// Pending post-Stop removals, keyed by agent id.
const turnEndTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelTurnEnd(agentId: string): void {
  const timer = turnEndTimers.get(agentId);
  if (timer === undefined) return;
  clearTimeout(timer);
  turnEndTimers.delete(agentId);
}

function scheduleTurnEnd(agentId: string, graceMs: number): void {
  cancelTurnEnd(agentId);
  const timer = setTimeout(() => {
    turnEndTimers.delete(agentId);
    // Not remembered as ended: the session is alive, and its next turn must
    // bring the node back.
    unregisterAgentSession(agentId);
  }, graceMs);
  timer.unref?.();
  turnEndTimers.set(agentId, timer);
}

// The session is gone (SessionEnd, or its terminal exited): drop the node now
// and hold the id in the recently-ended guard.
export function endProjectSession(sessionId: string): void {
  const agentId = projectSessionAgentId(sessionId);
  cancelTurnEnd(agentId);
  unregisterAgentSession(agentId);
  rememberEndedSession(sessionId);
}

// Apply one project session's hook event to the presence registry and report
// whether the caller should emit graph activity (a focus beam / satellite) for
// it:
//   - SessionEnd         → remove now; late stragglers are dropped (guard).
//   - SessionStart       → nothing: an idle session draws no node.
//   - Stop               → remove after TURN_END_GRACE_MS unless the session
//                          does something first.
//   - anything else      → the agent is working: create the node if absent
//     (UserPromptSubmit,   (this is also what brings a node back after the
//      tool use, subagent  idle TTL or a backend restart dropped it) and
//      events)             cancel any pending post-Stop removal.
// Exported for the regression test.
export function applyProjectActivityEvent(args: {
  event: string;
  sessionId: string;
  agentId: string;
  projectPath: string;
  label: string;
  harness?: AgentHarness;
  turnEndGraceMs?: number;
}): { emitActivity: boolean } {
  const { event, sessionId, agentId } = args;

  if (event === 'SessionEnd') {
    endProjectSession(sessionId);
    return { emitActivity: false };
  }

  // A hook reordered after this session's SessionEnd must not bring the node
  // back.
  if (recentlyEnded(sessionId)) return { emitActivity: false };

  if (event === 'SessionStart') {
    // Keep a live node alive (Claude also fires SessionStart after /compact,
    // mid-session) but never create one.
    touchAgentSession(agentId);
    return { emitActivity: false };
  }

  if (event === 'Stop') {
    if (touchAgentSession(agentId)) {
      scheduleTurnEnd(agentId, args.turnEndGraceMs ?? TURN_END_GRACE_MS);
    }
    return { emitActivity: false };
  }

  cancelTurnEnd(agentId);
  // Idempotent: refreshes liveness when the node already exists.
  registerAgentSession({
    agentId,
    projectPath: args.projectPath,
    label: args.label,
    ...(args.harness ? { harness: args.harness } : {}),
    idleTtlMs: PROJECT_SESSION_IDLE_TTL_MS,
  });
  return { emitActivity: true };
}
