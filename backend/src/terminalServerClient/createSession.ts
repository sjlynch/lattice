import {
  BASE,
  ensureTerminalServer,
  respawn,
} from '../terminalServerLifecycle.js';
import { resolveManagedClaudeServers } from '../mcp/registry.js';
import { isClaudeMemoryDisabled } from '../userSettings.js';
import type { ClaudeMcpServerConfig } from '../mcp/claudeInject.js';

export type CreateSessionOptions = {
  cwd?: string;
  initialCommand?: string;
  projectPath?: string;
  cols?: number;
  rows?: number;
  // Set only by the QA-lane e2e-run spawn. Used HERE (in the backend) to resolve
  // the QA-scoped Playwright (`qaPlaywright`); ordinary spawns omit it and get
  // Playwright only via the global `mcpOverrides.playwright` toggle. Not consumed
  // by the terminal-server itself. See mcp/registry.ts.
  isQaRun?: boolean;
};

// The POST /sessions wire body: the caller's options plus the spawn-time Claude
// config the BACKEND resolves here, so the detached terminal-server stays a dumb
// executor that only APPLIES this (it never resolves MCP/trust/memory policy
// itself). Threading the resolved config as DATA — instead of having the
// terminal-server import the resolver — is what keeps a spawn-policy change a
// backend-only edit that never forces a terminal-server respawn. See
// claudeTrust.ts / mcp/CLAUDE.md "Injection sites".
export type SessionWireBody = CreateSessionOptions & {
  // The managed MCP server set to reconcile into `projects[<cwd>]`, or `null`
  // for a trust-only seed. Absent for non-Claude spawns.
  managedMcpServers?: Record<string, ClaudeMcpServerConfig> | null;
  // Whether to set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the pty. Resolved here
  // from `UserSettings.disableClaudeMemory`. Absent for non-Claude spawns.
  disableClaudeMemory?: boolean;
};

function isClaudeCommand(initialCommand: string | undefined): boolean {
  return /^\s*claude\b/.test(initialCommand ?? '');
}

// Resolve the per-spawn Claude config (managed MCP servers + memory opt-out) in
// the always-fresh main backend and fold it into the wire body. Best-effort: a
// resolve failure degrades to a trust-only seed and Claude's default memory.
// Runs for Claude commands only; pi/codex/plain shells pass through untouched.
async function resolveClaudeSpawnBody(
  opts: CreateSessionOptions,
): Promise<SessionWireBody> {
  if (!opts.cwd || !isClaudeCommand(opts.initialCommand)) return opts;
  // No projectPath → trust-only seed (managed: null) + Claude's default memory.
  const managedMcpServers = opts.projectPath
    ? await resolveManagedClaudeServers(opts.projectPath, { isQaRun: opts.isQaRun })
    : null;
  const disableClaudeMemory = opts.projectPath
    ? await isClaudeMemoryDisabled(opts.projectPath).catch(() => false)
    : false;
  return { ...opts, managedMcpServers, disableClaudeMemory };
}

// Hard timeout on a single POST /sessions. Generous on purpose: a normal pty
// pre-create is sub-second, but under a heavy "Run All" burst the trust-seed
// file I/O on the shared ~/.claude.json plus the conpty spawn can legitimately
// take a few seconds, so anything under ~30s would risk aborting a spawn that
// was about to succeed. Past that, the request is almost certainly WEDGED (a
// stuck conpty handle or a black-holed socket to :5185), and we must not wait
// on it forever: the spawn queue holds a concurrency reservation for the WHOLE
// spawn thunk and only reclaims it once this call settles, so an un-timed hang
// here permanently leaks a slot and silently lowers the effective agent cap
// below the configured `maxConcurrentAgents` (the "Run All gave me 15 of 24"
// symptom). Bounding the call guarantees the thunk always settles and the slot
// is always returned to the queue.
const CREATE_SESSION_TIMEOUT_MS = 30_000;

// `code: 'CAP'` ⇒ the failure was the terminal-server's hard session cap.
// The spawn queue keys its over-admit back-off on this; any other failure
// is a genuine error.
export type CreateSessionResult =
  | { id: string }
  | { error: string; code?: 'CAP' };

type CreateOnce =
  | { id: string }
  | { error: string; recoverable: boolean; code?: 'CAP' };

// Pre-create a pty session in the terminal-server subprocess. Returns the
// session id so route handlers can include it in their response and the
// frontend can attach via that id later (instead of triggering creation by
// opening a WS).
//
// Reads the response body as text first, then parses JSON. A non-JSON body
// (HTML 404 from a stale terminal-server, or some other process bound to
// the port) returns a clear error AND triggers a one-shot respawn so the
// next call goes through. Without this, the user sees the unhelpful "JSON
// parse: Unexpected token '<'" error and tasks silently fail to spawn.
export async function proxyCreateSession(
  opts: CreateSessionOptions,
): Promise<CreateSessionResult> {
  await ensureTerminalServer();
  // Resolve the Claude spawn config ONCE (so a retry reuses the same body) and
  // in the always-fresh backend — the terminal-server only applies it.
  const body = await resolveClaudeSpawnBody(opts);
  const first = await tryCreateSessionOnce(body);
  if ('id' in first) return first;
  // Retry once if the failure was non-JSON (stale server / unrelated listener
  // on 5185). respawn() forces a clean restart even if the stale server's
  // /health currently still answers OK — the symptom proves it isn't really.
  if (first.recoverable) {
    console.warn(
      `[terminal-proxy] non-JSON response from terminal-server — forcing respawn and retrying once. First error: ${first.error}`,
    );
    await respawn();
    const second = await tryCreateSessionOnce(body);
    if ('id' in second) return second;
    return { error: second.error, code: second.code };
  }
  return { error: first.error, code: first.code };
}

export async function tryCreateSessionOnce(
  body: SessionWireBody,
): Promise<CreateOnce> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CREATE_SESSION_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      // The terminal-server is alive (it answered the /health probe in
      // ensureTerminalServer) but this one spawn wedged. Fail JUST this spawn
      // as NON-recoverable: a recoverable failure would trigger respawn(),
      // which shuts the whole terminal-server down and kills every live PTY —
      // catastrophic mid-run. Returning non-recoverable settles the thunk so
      // the spawn queue reclaims the reservation; the task simply re-queues.
      console.warn(
        `[terminal-proxy] POST /sessions timed out (>${CREATE_SESSION_TIMEOUT_MS}ms) — failing this spawn (queue slot reclaimed, will retry)`,
      );
      return {
        error: `terminal-server did not respond within ${CREATE_SESSION_TIMEOUT_MS}ms`,
        recoverable: false,
      };
    }
    // Connection errors (server died between probe and request) are
    // recoverable — a respawn will restore service.
    return { error: (err as Error).message, recoverable: true };
  }
  const text = await res.text().catch(() => '');
  type SessionBody = { id?: string; error?: string; code?: 'CAP' };
  let parsed: SessionBody | null = null;
  try {
    parsed = text ? (JSON.parse(text) as SessionBody) : null;
  } catch {
    // HTML / plain-text body → almost certainly a stale terminal-server
    // (missing route) or a wrong process bound to the port.
    const preview = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    return {
      error: `terminal-server returned non-JSON (status ${res.status}): ${preview}`,
      recoverable: true,
    };
  }
  if (!res.ok || !parsed?.id) {
    return {
      error: parsed?.error ?? `terminal-server ${res.status}`,
      recoverable: false,
      code: parsed?.code,
    };
  }
  return { id: parsed.id };
}
