// Per-agent-session "is it still working?" tracker.
//
// Claude's `Stop` hook is NOT a reliable "the agent is completely done"
// signal when the session uses the Task tool (subagents): it fires early and
// more than once, sometimes while a subagent is still running and seconds
// before the session actually ends. (Reproduced against Claude Code 2.1.218;
// see the workflow Stop-hook completion gate in
// `workflowRuns/stopHookGate.ts`, which consumes this.) Lattice already
// receives every one of a session's PreToolUse/PostToolUse/SubagentStart/
// SubagentStop hooks (they drive the graph's focus beams + satellites), so we
// can tell whether the session is quiescent independent of the racy Stop.
//
// This module keeps the minimal per-session state a completion gate needs:
//   - liveSubagents — how many Task subagents are currently in flight. A Stop
//     that arrives while this is > 0 is unambiguously premature. Tracked by
//     Claude's `agent_id`, not as a bare counter: interactive Claude Code also
//     fires SubagentStop for its own internal helper agents, which never had a
//     SubagentStart (seen on 2.1.280, 2026-09-23). As a counter, each stray stop
//     cancelled a real background subagent's start, the gate saw 0 live while
//     two Explore agents were still working, and the workflow step advanced
//     and was killed before its agent could file a single task.
//   - lastSignalAt  — the last time we saw ANY signal for the session (a tool
//     use, a subagent start/stop, or a Stop fire fed in by the gate). Quietness
//     is measured from here: an agent that is genuinely finished stops emitting
//     signals, so a long-enough gap means it is safe to advance.
//
// Deliberately generic (keyed by the caller's `agentId`) and side-effect-free
// so it stays trivially unit-testable and reusable by any Stop-hook consumer.

type QuiescenceState = {
  // Subagents started with an `agent_id`; only a stop carrying the same id
  // removes one.
  liveIds: Set<string>;
  // Starts that carried no id (older Claude builds); matched by id-less stops.
  anonymous: number;
  lastSignalAt: number;
  // When the last tracked subagent finished, and when the session last fired
  // Stop. A background subagent's result wakes the main agent for another
  // turn, which can think and run untracked tools (Bash) for longer than any
  // settle window — so after a subagent finishes, only a LATER Stop (the main
  // agent ending that turn) means the step is done.
  lastSubagentEndAt: number;
  lastStopAt: number;
  // The session was RE-ADOPTED after a backend restart (see
  // `markAgentReadopted`): whatever subagents it had in flight when the old
  // process died are invisible to this one, so `liveIds` may be missing some.
  readopted: boolean;
};

// How long a re-adopted session must be completely quiet before a Stop-hook
// gate may treat it as finished. This map is in-memory, so a backend restart
// forgets every subagent a session had started: a background subagent that
// began before the restart never shows up in `liveIds`, and its session's
// next Stop (the main agent ending its turn to wait for it) would otherwise
// pass the normal few-second settle window and advance / finish while the
// subagent is still working — the step gets killed mid-work. There is no way
// to learn the missing ids after the fact (a SubagentStop for an unknown id is
// ambiguous: Claude Code also fires them for its own internal agents), so
// instead a re-adopted session needs a much longer quiet window. Any hook a
// surviving subagent fires (its own tool use carries the parent's token) is a
// signal that restarts it. Costs a couple of minutes of tail latency, once,
// and only for a session that lived through a restart.
export const READOPTED_SETTLE_MS = 120_000;

const states = new Map<string, QuiescenceState>();

function ensure(agentId: string, now: number): QuiescenceState {
  let s = states.get(agentId);
  if (!s) {
    s = { liveIds: new Set(), anonymous: 0, lastSignalAt: now, lastSubagentEndAt: 0, lastStopAt: 0, readopted: false };
    states.set(agentId, s);
  }
  return s;
}

// A subagent (Task/Agent) started — SubagentStart. Also a live signal.
// `subagentId` is the hook's `agent_id` when present.
export function noteSubagentStart(agentId: string, subagentId?: string | null): void {
  const now = Date.now();
  const s = ensure(agentId, now);
  if (subagentId) s.liveIds.add(subagentId);
  else s.anonymous += 1;
  s.lastSignalAt = now;
}

// A subagent finished — SubagentStop. A stop for an id this session never
// started (Claude Code's internal agents) changes nothing but the signal
// time; an id-less stop is clamped at 0 so a missed/duplicate start can never
// drive the count negative.
export function noteSubagentStop(agentId: string, subagentId?: string | null): void {
  const now = Date.now();
  const s = ensure(agentId, now);
  if (subagentId ? s.liveIds.delete(subagentId) : s.anonymous > 0) {
    if (!subagentId) s.anonymous -= 1;
    s.lastSubagentEndAt = now;
  }
  s.lastSignalAt = now;
}

// The session fired its Stop hook. Also a live signal (a later Stop pushes the
// settle window out).
export function noteAgentStop(agentId: string): void {
  const now = Date.now();
  const s = ensure(agentId, now);
  s.lastSignalAt = now;
  s.lastStopAt = now;
}

// Any other activity signal from the session (a tracked tool use, or a Stop
// fire the gate wants to count as "still alive so it can extend its window").
export function noteAgentSignal(agentId: string): void {
  const now = Date.now();
  ensure(agentId, now).lastSignalAt = now;
}

// Boot recovery re-adopted this session from a previous backend process (a
// workflow step or post-merge hook whose pty survived in the detached
// terminal-server). Its subagent state is unknown, so every later gate check
// uses `READOPTED_SETTLE_MS` (see above). The adoption itself counts as a
// signal: we don't know when the session last did anything. Sticky until the
// entry is forgotten (the step advances / the hook finishes).
//
// `lastStopAt`: the session's last Stop as the previous process recorded it
// (a Stop that was waiting on the gate when the backend went down — see
// WorkflowRun.stopReceived). The quiet window then counts from that Stop, not
// from this boot: otherwise every restart would push a finished step's advance
// out by another READOPTED_SETTLE_MS, and restarts closer together than that
// (a burst of merges into Lattice's own backend) would hold it forever. A
// surviving subagent's next hook still restarts the window.
//
// Idempotent: boot registration marks a session before callbacks are released,
// and the later resume pass marks it again — the second call must not reset the
// clock the first one set.
export function markAgentReadopted(agentId: string, lastStopAt?: number): void {
  const now = Date.now();
  const s = ensure(agentId, now);
  if (s.readopted) return;
  s.readopted = true;
  if (lastStopAt !== undefined) {
    s.lastSignalAt = Math.min(now, lastStopAt);
    s.lastStopAt = Math.min(now, lastStopAt);
  } else {
    s.lastSignalAt = now;
  }
}

// Snapshot for a completion gate. An unknown agent (never emitted a signal) is
// reported as quiescent with no live subagents — the gate then advances after
// its own settle delay, matching the pre-gate single-Stop behaviour.
//
// `awaitingTurnEnd`: a tracked subagent finished after the session's last
// Stop — its parent has a turn left to take (and to end with another Stop).
export function agentQuiescence(
  agentId: string,
): { liveSubagents: number; quietForMs: number; awaitingTurnEnd: boolean; readopted: boolean } {
  const s = states.get(agentId);
  if (!s) return { liveSubagents: 0, quietForMs: Number.POSITIVE_INFINITY, awaitingTurnEnd: false, readopted: false };
  return {
    liveSubagents: s.liveIds.size + s.anonymous,
    quietForMs: Date.now() - s.lastSignalAt,
    awaitingTurnEnd: s.lastSubagentEndAt > s.lastStopAt,
    readopted: s.readopted,
  };
}

// Whether a Stop-hook completion gate may advance now. A re-adopted session
// must be quiet for at least `READOPTED_SETTLE_MS`, whatever the caller's
// normal settle window.
export function isAgentQuiescent(agentId: string, settleMs: number): boolean {
  const q = agentQuiescence(agentId);
  const settle = q.readopted ? Math.max(settleMs, READOPTED_SETTLE_MS) : settleMs;
  return q.liveSubagents === 0 && !q.awaitingTurnEnd && q.quietForMs >= settle;
}

// Drop a session's state once its step has advanced (or the run ended). Safe to
// call for an unknown id.
export function forgetAgentQuiescence(agentId: string): void {
  states.delete(agentId);
}
