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
//
// The token is HMAC-signed (see TOKEN_SECRET) so a forged base64url payload
// can't drive graph presence/beams. The backend both mints and verifies, so
// the signature is purely an authenticity check — no key distribution.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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

type AgentTokenPayload = {
  agentId: string;
  projectPath: string;
  label: string;
};

// Per-boot secret used to HMAC the token payload. Regenerated each process
// start: a token minted before a restart stops validating after one, which is
// acceptable — the session it identified is gone too, and project
// instrumentation re-mints its token on the next project-open. The secret
// never leaves the process (it's not persisted or sent anywhere), so it can't
// be recovered to forge a token offline.
const TOKEN_SECRET = randomBytes(32);

// Separator between the base64url payload and its signature. `.` is outside
// the base64url alphabet (so it can't appear inside either half) yet is still
// URL-path-safe and shell-safe — keeping the whole token a single unquoted
// path segment, as the hook curl requires.
const TOKEN_SEP = '.';

function signPayload(payloadB64: string): string {
  return createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
}

// Constant-time signature check. timingSafeEqual throws on a length mismatch,
// so guard first (a forged signature of the wrong length is simply rejected).
function signatureValid(payloadB64: string, sig: string): boolean {
  const expected = Buffer.from(signPayload(payloadB64));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// Encode the routing info into a URL-path-safe, HMAC-signed token. base64url
// has no `&`, `/`, `?`, or other shell/URL-special chars, and `.` (the
// payload/signature separator) is also path- and shell-safe, so the hook
// command can carry the whole token unquoted in a single-segment path.
export function encodeAgentToken(payload: AgentTokenPayload): string {
  const json = JSON.stringify({
    a: payload.agentId,
    p: payload.projectPath,
    l: payload.label,
  });
  const body = Buffer.from(json, 'utf8').toString('base64url');
  return `${body}${TOKEN_SEP}${signPayload(body)}`;
}

export function decodeAgentToken(token: string): AgentTokenPayload | null {
  // Require exactly `<payload>.<signature>`, both non-empty. An old-scheme
  // unsigned token (a bare base64url payload, no separator) fails here, as
  // does anything with a stray extra separator.
  const parts = token.split(TOKEN_SEP);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  if (!signatureValid(body, sig)) return null;
  try {
    const json = Buffer.from(body, 'base64url').toString('utf8');
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
