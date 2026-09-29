import { BASE } from '../terminalServerLifecycle.js';
import { terminalServerAuthHeaders } from '../terminalServerAuth.js';

// Hard timeout shared by the three cheap session probes below (list / count /
// kill-by-cwd). All three are best-effort reads against the detached
// terminal-server on :5185, awaited on hot paths (spawn-queue accounting,
// recovery sweeps, worktree teardown) where a wedged terminal-server must
// surface as "can't tell" / "best-effort" fast rather than hang. The two other
// timeouts in this subsystem stay separate on purpose — CREATE_SESSION (30s,
// ./createSession.ts) and SHUTDOWN_POST (2s, ./shutdown.ts) have genuinely
// different intents.
const SESSIONS_PROBE_TIMEOUT_MS = 3_000;

export async function proxyListSessions(): Promise<unknown[]> {
  try {
    const res = await fetch(`${BASE}/sessions`, {
      headers: terminalServerAuthHeaders(),
      signal: AbortSignal.timeout(SESSIONS_PROBE_TIMEOUT_MS),
    });
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
export async function proxyListSessionsOrNull(): Promise<unknown[] | null> {
  try {
    const res = await fetch(`${BASE}/sessions`, {
      headers: terminalServerAuthHeaders(),
      signal: AbortSignal.timeout(SESSIONS_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (data as unknown[]) : null;
  } catch {
    return null;
  }
}

// A short-lived, single-flighted snapshot of proxyListSessionsOrNull for
// periodic readers that only need a recent view (today: the terminal-activity
// poller, 1 Hz). Not for paths that act on exact liveness right now — the
// spawn queue's admission count, recovery sweeps, restore, and the
// terminal-registry watch (a snapshot taken before a pty was spawned reports
// it missing, and the watch would end its record) — those call the uncached
// form.
const SESSIONS_SNAPSHOT_TTL_MS = 750;
let sessionsSnapshot: { at: number; value: unknown[] | null } | null = null;
let sessionsSnapshotInFlight: Promise<unknown[] | null> | null = null;

export function proxyListSessionsShared(
  opts: { ttlMs?: number; now?: () => number; list?: () => Promise<unknown[] | null> } = {},
): Promise<unknown[] | null> {
  const now = opts.now ?? Date.now;
  if (sessionsSnapshot && now() - sessionsSnapshot.at < (opts.ttlMs ?? SESSIONS_SNAPSHOT_TTL_MS)) {
    return Promise.resolve(sessionsSnapshot.value);
  }
  if (sessionsSnapshotInFlight) return sessionsSnapshotInFlight;
  const promise = (opts.list ?? proxyListSessionsOrNull)()
    .then((value) => {
      sessionsSnapshot = { at: now(), value };
      return value;
    })
    .finally(() => {
      if (sessionsSnapshotInFlight === promise) sessionsSnapshotInFlight = null;
    });
  sessionsSnapshotInFlight = promise;
  return promise;
}

// Test seam.
export function resetSessionsSnapshot(): void {
  sessionsSnapshot = null;
  sessionsSnapshotInFlight = null;
}

// Authoritative live-session count for the spawn queue's accounting.
// Returns `null` (NOT 0) when the terminal-server is unreachable or answers
// unparseably — the queue must distinguish "can't tell" from a real empty
// terminal-server and freeze admissions rather than over-admit.
export async function proxyCountSessions(): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/sessions`, {
      headers: terminalServerAuthHeaders(),
      signal: AbortSignal.timeout(SESSIONS_PROBE_TIMEOUT_MS),
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
export async function proxyKillSessionsByCwd(worktreePath: string): Promise<void> {
  try {
    const res = await fetch(
      `${BASE}/sessions/by-cwd?cwd=${encodeURIComponent(worktreePath)}`,
      {
        method: 'DELETE',
        headers: terminalServerAuthHeaders(),
        signal: AbortSignal.timeout(SESSIONS_PROBE_TIMEOUT_MS),
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
        `[terminal-proxy] kill-by-cwd timed out (>${SESSIONS_PROBE_TIMEOUT_MS}ms) for ${worktreePath} — terminal-server may be wedged`,
      );
    }
  }
}

const killsInFlight = new Map<string, Promise<boolean>>();

export function proxyKillSession(id: string): Promise<boolean> {
  const existing = killsInFlight.get(id);
  if (existing) return existing;
  const killing = killSessionOnce(id).finally(() => {
    if (killsInFlight.get(id) === killing) killsInFlight.delete(id);
  });
  killsInFlight.set(id, killing);
  return killing;
}

async function killSessionOnce(id: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE}/sessions/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: terminalServerAuthHeaders(),
        signal: AbortSignal.timeout(SESSIONS_PROBE_TIMEOUT_MS),
      },
    );
    // 404 is authoritative absence, unlike a transport error or 5xx. A retry
    // after a lost acknowledgement may find the PTY already removed.
    return res.ok || res.status === 404;
  } catch {
    // Terminal server down, wedged, or timed out — treat as kill-unconfirmed
    // (false) so awaiting callers (workflow advance, post-merge abort,
    // DELETE /api/terminals/:id) proceed instead of hanging.
    return false;
  }
}
