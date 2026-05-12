import {
  BASE,
  ensureTerminalServer,
  respawn,
} from './terminalServerLifecycle.js';

export async function proxyListSessions(): Promise<unknown[]> {
  try {
    const res = await fetch(`${BASE}/sessions`);
    return res.ok ? ((await res.json()) as unknown[]) : [];
  } catch {
    return [];
  }
}

// Kill all terminal sessions whose cwd is inside `worktreePath`.
// Call before deleting a worktree directory so Windows releases file locks.
export async function proxyKillSessionsByCwd(worktreePath: string): Promise<void> {
  try {
    const res = await fetch(
      `${BASE}/sessions/by-cwd?cwd=${encodeURIComponent(worktreePath)}`,
      { method: 'DELETE' },
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
  } catch {
    /* terminal server down or no matching sessions — safe to ignore */
  }
}

export type CreateSessionOptions = {
  cwd?: string;
  initialCommand?: string;
  projectPath?: string;
  cols?: number;
  rows?: number;
};

export type CreateSessionResult = { id: string } | { error: string };

type CreateOnce =
  | { id: string }
  | { error: string; recoverable: boolean };

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
  const first = await tryCreateSessionOnce(opts);
  if ('id' in first) return first;
  // Retry once if the failure was non-JSON (stale server / unrelated listener
  // on 5185). respawn() forces a clean restart even if the stale server's
  // /health currently still answers OK — the symptom proves it isn't really.
  if (first.recoverable) {
    console.warn(
      `[terminal-proxy] non-JSON response from terminal-server — forcing respawn and retrying once. First error: ${first.error}`,
    );
    await respawn();
    const second = await tryCreateSessionOnce(opts);
    if ('id' in second) return second;
    return { error: second.error };
  }
  return { error: first.error };
}

export async function tryCreateSessionOnce(
  opts: CreateSessionOptions,
): Promise<CreateOnce> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
  } catch (err) {
    // Connection errors (server died between probe and request) are
    // recoverable — a respawn will restore service.
    return { error: (err as Error).message, recoverable: true };
  }
  const text = await res.text().catch(() => '');
  let parsed: { id?: string; error?: string } | null = null;
  try {
    parsed = text ? (JSON.parse(text) as { id?: string; error?: string }) : null;
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
export async function proxyShutdown(): Promise<void> {
  try {
    await fetch(`${BASE}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* terminal server already down or unreachable — nothing to clean up */
  }
}
