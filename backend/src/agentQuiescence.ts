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
//     that arrives while this is > 0 is unambiguously premature.
//   - lastSignalAt  — the last time we saw ANY signal for the session (a tool
//     use, a subagent start/stop, or a Stop fire fed in by the gate). Quietness
//     is measured from here: an agent that is genuinely finished stops emitting
//     signals, so a long-enough gap means it is safe to advance.
//
// Deliberately generic (keyed by the caller's `agentId`) and side-effect-free
// so it stays trivially unit-testable and reusable by any Stop-hook consumer.

type QuiescenceState = {
  liveSubagents: number;
  lastSignalAt: number;
};

const states = new Map<string, QuiescenceState>();

function ensure(agentId: string, now: number): QuiescenceState {
  let s = states.get(agentId);
  if (!s) {
    s = { liveSubagents: 0, lastSignalAt: now };
    states.set(agentId, s);
  }
  return s;
}

// A subagent (Task/Agent) started — SubagentStart. Also a live signal.
export function noteSubagentStart(agentId: string): void {
  const now = Date.now();
  const s = ensure(agentId, now);
  s.liveSubagents += 1;
  s.lastSignalAt = now;
}

// A subagent finished — SubagentStop. Clamped at 0 so a missed/duplicate
// SubagentStart can never drive the count negative (which would make the
// session look permanently busy and strand the run).
export function noteSubagentStop(agentId: string): void {
  const now = Date.now();
  const s = ensure(agentId, now);
  s.liveSubagents = Math.max(0, s.liveSubagents - 1);
  s.lastSignalAt = now;
}

// Any other activity signal from the session (a tracked tool use, or a Stop
// fire the gate wants to count as "still alive so it can extend its window").
export function noteAgentSignal(agentId: string): void {
  const now = Date.now();
  ensure(agentId, now).lastSignalAt = now;
}

// Snapshot for a completion gate. An unknown agent (never emitted a signal) is
// reported as quiescent with no live subagents — the gate then advances after
// its own settle delay, matching the pre-gate single-Stop behaviour.
export function agentQuiescence(
  agentId: string,
): { liveSubagents: number; quietForMs: number } {
  const s = states.get(agentId);
  if (!s) return { liveSubagents: 0, quietForMs: Number.POSITIVE_INFINITY };
  return { liveSubagents: s.liveSubagents, quietForMs: Date.now() - s.lastSignalAt };
}

// Drop a session's state once its step has advanced (or the run ended). Safe to
// call for an unknown id.
export function forgetAgentQuiescence(agentId: string): void {
  states.delete(agentId);
}
