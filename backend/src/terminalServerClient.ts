import {
  BASE,
  ensureTerminalServer,
  respawn,
} from './terminalServerLifecycle.js';
import { resolveManagedClaudeServers } from './mcp/registry.js';
import { isClaudeMemoryDisabled } from './userSettings.js';
import type { ClaudeMcpServerConfig } from './mcp/claudeInject.js';

export async function proxyListSessions(): Promise<unknown[]> {
  try {
    const res = await fetch(`${BASE}/sessions`);
    return res.ok ? ((await res.json()) as unknown[]) : [];
  } catch {
    return [];
  }
}

// Like proxyListSessions but returns `null` (NOT []) when the terminal-server
// is unreachable or answers unparseably — mirrors proxyCountSessions. Callers
// that act on "no live sessions" (e.g. the recovery sweeps, which delete a
// scratch dir when nothing live owns it) MUST distinguish "can't tell" from a
// real empty list, or a transient fetch failure would look like "no sessions"
// and they'd reclaim a still-live session's dir.
const LIST_SESSIONS_TIMEOUT_MS = 3_000;

export async function proxyListSessionsOrNull(): Promise<unknown[] | null> {
  try {
    const res = await fetch(`${BASE}/sessions`, {
      signal: AbortSignal.timeout(LIST_SESSIONS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (data as unknown[]) : null;
  } catch {
    return null;
  }
}

// Authoritative live-session count for the spawn queue's accounting.
// Returns `null` (NOT 0) when the terminal-server is unreachable or answers
// unparseably — the queue must distinguish "can't tell" from a real empty
// terminal-server and freeze admissions rather than over-admit.
const COUNT_SESSIONS_TIMEOUT_MS = 3_000;

export async function proxyCountSessions(): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/sessions`, {
      signal: AbortSignal.timeout(COUNT_SESSIONS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data.length : null;
  } catch {
    return null;
  }
}

// Kill all terminal sessions whose cwd is inside `worktreePath`.
// Call before deleting a worktree directory so Windows releases file locks.
// Hard-timeouts the request so a wedged terminal-server (an old orphan
// whose event loop is stuck on a sync subprocess, an exhausted handle,
// etc.) can't hang the boot-time push-session sweep or any worktree
// teardown — both call this in a loop, and an indefinite-hang here
// would freeze recovery and prevent the backend from ever listening.
const KILL_BY_CWD_TIMEOUT_MS = 3_000;

export async function proxyKillSessionsByCwd(worktreePath: string): Promise<void> {
  try {
    const res = await fetch(
      `${BASE}/sessions/by-cwd?cwd=${encodeURIComponent(worktreePath)}`,
      {
        method: 'DELETE',
        signal: AbortSignal.timeout(KILL_BY_CWD_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      // A non-OK response means the route didn't kill anything — most likely
      // a route-ordering regression (`/sessions/:id` capturing `by-cwd`) or
      // the terminal server is in a degraded state. Either way the PTYs are
      // leaking; surface it loudly instead of leaving orphans on the box.
      console.warn(
        `[terminal-proxy] kill-by-cwd failed: ${res.status} for ${worktreePath}`,
      );
    }
  } catch (err) {
    // Terminal server down, wedged, or no matching sessions — best-effort.
    // Log just enough to distinguish "no server" from "timed out" so a
    // wedged terminal-server is visible in the logs without spam.
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      console.warn(
        `[terminal-proxy] kill-by-cwd timed out (>${KILL_BY_CWD_TIMEOUT_MS}ms) for ${worktreePath} — terminal-server may be wedged`,
      );
    }
  }
}

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

export async function proxyKillSession(id: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE}/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// Tell the detached terminal server to kill all sessions and exit. Called
// by the dev orchestrator on Ctrl+C; the terminal server does not naturally
// receive that signal because it's detached + unref'd by design (so backend
// restarts don't kill PTYs).
const SHUTDOWN_POST_TIMEOUT_MS = 2_000;

export async function proxyShutdown(): Promise<void> {
  try {
    await fetch(`${BASE}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(SHUTDOWN_POST_TIMEOUT_MS),
    });
  } catch {
    /* terminal server already down or unreachable — nothing to clean up */
  }
}
