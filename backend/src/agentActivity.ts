// Non-worktree Claude session activity.
//
// Lattice spawns Claude sessions outside task worktrees too (push runs,
// workflow steps, post-merge hooks). Each runs in its own scratch dir with a
// `.claude/settings.local.json`; we add the same PreToolUse/PostToolUse
// activity hooks there as for task worktrees, but pointing at a generic
// `/api/agent-activity/<token>` endpoint. The graph renders an orange
// (Claude-colored) free-floating node for each, with the same focus beams.
//
// The model is deliberately STATELESS: the HMAC-signed token baked into the
// hook URL (see agentActivityTokens.ts) carries everything the endpoint needs
// (agent id, project, label), so there is no server-side registry to keep in
// sync with session lifecycles. The frontend creates the node on first
// activity and TTL-expires it when the session goes quiet — no explicit
// "session ended" signal required.

export type AgentActivityPhase = 'start' | 'end';
// A subagent (Task/Agent) of this session's Claude appeared ('spawn',
// SubagentStart) or finished ('stop', SubagentStop). These carry no `file`.
export type AgentActivityLifecycle = 'spawn' | 'stop';

export type AgentActivityEvent = {
  projectPath: string;
  // Stable per-session id (e.g. `push:<id>`, `wf:<runId>:<step>`,
  // `pmh:<id>`). Used as the graph node key; namespaced so it never collides
  // with a task id.
  agentId: string;
  // Human label for the session kind (for tooltips/debug).
  label: string;
  // Project-absolute path of the touched file (matches a graph node `path`).
  // Absent on `lifecycle` (SubagentStart/Stop) events.
  file?: string;
  phase: AgentActivityPhase;
  tool: string;
  ts: number;
  // Subagent attribution — see TaskActivityEvent. When set, the event pertains
  // to a satellite of this session's Claude node.
  subagentId?: string;
  subagentType?: string;
  // Set for SubagentStart ('spawn') / SubagentStop ('stop').
  lifecycle?: AgentActivityLifecycle;
};

type Listener = (event: AgentActivityEvent) => void;

const listeners = new Set<Listener>();

export function subscribeAgentActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyAgentActivity(event: AgentActivityEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[agent-activity] listener threw:', err);
    }
  }
}
