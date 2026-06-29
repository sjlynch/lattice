import {
  registerAgentSession,
  touchAgentSession,
  unregisterAgentSession,
} from '../agentSessions.js';

// A project session that goes quiet for this long is dropped — a safety net
// for a session that exits without firing SessionEnd (hard-killed terminal).
// SessionEnd is the primary, prompt removal signal; this is generous so a
// merely-idle (but alive) session doesn't flicker out.
export const PROJECT_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;

// After a session's SessionEnd we briefly remember its session_id so a hook
// that arrives AFTER SessionEnd can't resurrect the node. Each Claude hook is
// an independent `curl -m 2` with no ordering guarantee, so a final PostToolUse
// (or a reordered SessionStart) can land after SessionEnd; the curl gives up
// after 2s, so any straggler arrives well within this window. Generous so a
// late hook never slips past it.
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

// Apply one project-instrumented session's lifecycle/activity event to the
// presence registry and report whether the caller should emit a focus-beam
// activity event for it. Presence is owned by SessionStart (create) and
// SessionEnd (remove) ONLY; tool-use / subagent events are refresh-only via
// touchAgentSession — a no-op once the session is gone. This mirrors
// routes/agentActivity.ts ('presence is owned by the spawn + completion
// callbacks, so we never resurrect here') and fixes the asymmetry where this
// route used to registerAgentSession (which CREATES) on every non-SessionEnd
// event: a late PostToolUse after SessionEnd resurrected a ghost node that then
// lingered for the full PROJECT_SESSION_IDLE_TTL_MS. The recentlyEnded guard
// additionally drops a reordered SessionStart for an already-ended session,
// which touch-only alone wouldn't catch. Exported for the regression test.
export function applyProjectActivityEvent(args: {
  event: string;
  sessionId: string;
  agentId: string;
  projectPath: string;
  label: string;
}): { emitActivity: boolean } {
  const { event, sessionId, agentId } = args;

  if (event === 'SessionEnd') {
    unregisterAgentSession(agentId);
    rememberEndedSession(sessionId);
    return { emitActivity: false };
  }

  // A hook reordered after this session's SessionEnd must not bring the node
  // back — drop every event for a just-ended session_id, SessionStart included.
  if (recentlyEnded(sessionId)) return { emitActivity: false };

  if (event === 'SessionStart') {
    // SessionStart is the only event that may CREATE the node (no matcher, so
    // it fires reliably at session start). registerAgentSession is idempotent.
    registerAgentSession({
      agentId,
      projectPath: args.projectPath,
      label: args.label,
      idleTtlMs: PROJECT_SESSION_IDLE_TTL_MS,
    });
    return { emitActivity: false };
  }

  // PreToolUse / PostToolUse / SubagentStart / SubagentStop → refresh liveness
  // only. touchAgentSession returns false (and creates nothing) when the
  // session is gone, so a stray post-SessionEnd hook is a no-op; with no node
  // to anchor it we also skip the focus-beam emit.
  if (!touchAgentSession(agentId)) return { emitActivity: false };
  return { emitActivity: true };
}
