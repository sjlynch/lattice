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
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { latticeHomeDir } from './projectPath.js';

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

// HMAC secret for the activity token. PERSISTED to `~/.lattice/agentTokenSecret`
// (chmod 0600) and loaded once at startup — it MUST survive a backend restart,
// because the token is baked into long-lived hook commands that outlive this
// process:
//   - `<project>/.claude/settings.local.json` for project-instrumented sessions
//     (a `claude` you run yourself — alive for hours, across many dev restarts);
//   - push / workflow-step / post-merge scratch hooks, whose Claude pty lives in
//     the DETACHED terminal-server and so likewise survives a main-server boot.
// A per-boot random secret (the previous behaviour) silently invalidated every
// one of those tokens on the first `tsc -w` restart: `decodeAgentToken` then
// returned null and the activity route dropped the event, so the agent's graph
// node + focus beams + subagent satellites vanished and never came back until
// BOTH the project was re-opened AND the session restarted. Persisting the
// secret keeps a baked token valid forever, so no restart is ever needed.
//
// Security is unchanged in substance: the secret stays on the user's machine
// (home dir, best-effort 0600) and never crosses the wire, so it remains a pure
// authenticity check against a forged browser payload. Anyone who can read this
// file already has local filesystem access (and could do far worse) — the same
// trust boundary as `~/.lattice/mcpSecrets.json`.
function loadOrCreateTokenSecret(): Buffer {
  const file = path.join(latticeHomeDir(), 'agentTokenSecret');
  try {
    const existing = readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch {
    /* absent or unreadable — fall through and create one */
  }
  const secret = randomBytes(32);
  try {
    mkdirSync(latticeHomeDir(), { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    chmodSync(file, 0o600); // best-effort owner-only (inert on Windows)
  } catch (err) {
    // Couldn't persist (read-only FS / perms): degrade to a process-lifetime
    // secret. Tokens then don't survive a restart — the old behaviour — but the
    // feature still works within a single boot rather than crashing at import.
    console.warn('[agent-activity] could not persist token secret:', err);
  }
  return secret;
}

const TOKEN_SECRET = loadOrCreateTokenSecret();

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
