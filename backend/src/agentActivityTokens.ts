// HMAC-signed activity tokens for non-worktree/project Claude hooks.
//
// The backend mints these into hook URLs and later verifies them on callback,
// so token handling is deliberately kept separate from the event pub/sub in
// agentActivity.ts.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { latticeHomeDir } from './projectPath.js';
import { loadOrCreatePersistedSecret } from './persistedSecretFile.js';

export type AgentTokenPayload = {
  agentId: string;
  projectPath: string;
  label: string;
};

// HMAC secret for the activity token. PERSISTED to `~/.lattice/agentTokenSecret`
// (chmod 0600) and loaded once, on first use — it MUST survive a backend restart,
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
//
// A transiently unreadable file (EBUSY/EPERM from AV/backup/indexer) must NOT
// be replaced — that would invalidate every baked token for good. Instead this
// process runs on an in-memory secret that is never written: its own tokens
// work until the next boot, which reads the untouched real secret again.
let tokenSecret: Buffer | null = null;

function getTokenSecret(): Buffer {
  if (tokenSecret) return tokenSecret;
  try {
    tokenSecret = loadOrCreatePersistedSecret({
      file: path.join(latticeHomeDir(), 'agentTokenSecret'),
      label: '[agent-activity]',
      parse: (raw) => (raw.length >= 32 ? raw : null),
      generate: () => {
        const secret = randomBytes(32);
        return { value: secret, bytes: secret };
      },
    }).value;
  } catch (err) {
    console.error(
      '[agent-activity] token secret unreadable — using a process-lifetime secret ' +
        '(previously issued activity tokens will not validate until restart):',
      err,
    );
    tokenSecret = randomBytes(32);
  }
  return tokenSecret;
}

export function resetAgentTokenSecretForTests(): void {
  tokenSecret = null;
}

// Separator between the base64url payload and its signature. `.` is outside
// the base64url alphabet (so it can't appear inside either half) yet is still
// URL-path-safe and shell-safe — keeping the whole token a single unquoted
// path segment, as the hook curl requires.
const TOKEN_SEP = '.';

function signPayload(payloadB64: string): string {
  return createHmac('sha256', getTokenSecret()).update(payloadB64).digest('base64url');
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
