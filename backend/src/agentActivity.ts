// Non-worktree Claude session activity.
//
// Lattice spawns Claude sessions outside task worktrees too (push runs,
// workflow steps, post-merge hooks). Each runs in its own scratch dir with a
// `.claude/settings.local.json`; we add the same PreToolUse/PostToolUse
// activity hooks there as for task worktrees, but pointing at a generic
// `/api/agent-activity/<token>` endpoint. The graph renders an orange
// (Claude-colored) free-floating node for each, with the same focus beams.
//
// The model is deliberately STATELESS: the token baked into the hook URL
// carries everything the endpoint needs (agent id, project, label), so there
// is no server-side registry to keep in sync with session lifecycles. The
// frontend creates the node on first activity and TTL-expires it when the
// session goes quiet — no explicit "session ended" signal required.

export type AgentActivityPhase = 'start' | 'end';

export type AgentActivityEvent = {
  projectPath: string;
  // Stable per-session id (e.g. `push:<id>`, `wf:<runId>:<step>`,
  // `pmh:<id>`). Used as the graph node key; namespaced so it never collides
  // with a task id.
  agentId: string;
  // Human label for the session kind (for tooltips/debug).
  label: string;
  // Project-absolute path of the touched file (matches a graph node `path`).
  file: string;
  phase: AgentActivityPhase;
  tool: string;
  ts: number;
};

type AgentTokenPayload = {
  agentId: string;
  projectPath: string;
  label: string;
};

// Encode the routing info into a URL-path-safe token. base64url has no `&`,
// `/`, `?`, or other shell/URL-special chars, so the hook command can carry
// it unquoted in a single-segment path.
export function encodeAgentToken(payload: AgentTokenPayload): string {
  const json = JSON.stringify({
    a: payload.agentId,
    p: payload.projectPath,
    l: payload.label,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeAgentToken(token: string): AgentTokenPayload | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof obj.a === 'string' &&
      typeof obj.p === 'string' &&
      typeof obj.l === 'string'
    ) {
      return { agentId: obj.a, projectPath: obj.p, label: obj.l };
    }
  } catch {
    /* malformed token */
  }
  return null;
}

// The activity-hook URL for a non-worktree Claude session. Pass to
// `installClaudeHooks(cwd, { completeUrl, activityUrl })`.
export function buildAgentActivityUrl(
  backendOrigin: string,
  payload: AgentTokenPayload,
): string {
  return `${backendOrigin}/api/agent-activity/${encodeAgentToken(payload)}`;
}

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
