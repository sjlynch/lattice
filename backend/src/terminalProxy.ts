// Manages the lifecycle of the terminal server (a separate process on port
// 5185) and proxies terminal WebSocket connections to it.
//
// Design rationale: PTY sessions are owned by terminal-server.ts, which runs
// detached from the main server. When the main server restarts (e.g. during
// development), the terminal server keeps running and all Claude agents inside
// it continue uninterrupted. The main server reconnects on next startup.

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { computeTerminalFingerprint } from './terminalFingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 5185;
const BASE = `http://127.0.0.1:${TERMINAL_PORT}`;

// Content-hash of the terminal-server's runtime files, computed from the
// SAME files the spawned terminal-server hashes itself. A running server
// whose fingerprint differs from this one is built from older bytes and
// must be respawned. No manual version constant to forget to bump.
const EXPECTED_TERMINAL_FINGERPRINT = computeTerminalFingerprint();

type ProbeResult = 'ok' | 'stale' | 'dead';

async function probeServer(): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(500),
    });
  } catch {
    return 'dead';
  }
  if (!res.ok) return 'stale';
  try {
    const body = (await res.json()) as {
      ok?: boolean;
      fingerprint?: string;
      // Pre-fingerprint health responses include `apiVersion`. Any of those
      // are by definition stale relative to the current backend.
      apiVersion?: number;
    };
    if (typeof body.fingerprint !== 'string') return 'stale';
    if (body.fingerprint !== EXPECTED_TERMINAL_FINGERPRINT) return 'stale';
    return 'ok';
  } catch {
    return 'stale';
  }
}

async function shutdownStale(): Promise<void> {
  // The /shutdown endpoint exists on newer servers; older ones 404 it.
  // Either way we best-effort the call and then poll for port release.
  try {
    await fetch(`${BASE}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* old server may already be dying or never had the endpoint */
  }
  // Poll the kernel directly for port release, not probeServer — a wedged
  // /health times out and returns 'dead' too, which would make the loop
  // exit prematurely while the port is still held.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 150));
    if (!isPortListening(TERMINAL_PORT)) return;
  }
  // Polite shutdown didn't take. Common causes seen in the wild:
  //   - orphan was built before /shutdown existed (route 404'd silently)
  //   - shutdown handler hung on a wedged pty.kill()
  //   - some other process happens to be squatting on the port
  // Fall back to a port-targeted force-kill. Without this, EADDRINUSE
  // blocks every subsequent spawn until the user manually intervenes.
  console.warn(
    `[lattice-backend] polite shutdown timed out on ${TERMINAL_PORT} — escalating to force-kill`,
  );
  await forceKillByPort(TERMINAL_PORT);
}

// Asks the kernel whether anything has the port bound in LISTENING state.
// Distinct from probeServer: probeServer asks "does /health respond with
// the right fingerprint within 500 ms?" — and a wedged event loop fails
// that probe even though the port is very much held. Used before spawn
// to decide whether to force-kill an orphan we couldn't reach via HTTP.
// Windows-only for now; on POSIX an EADDRINUSE from spawn is loud enough
// to debug from logs that we haven't needed the same self-heal.
function isPortListening(port: number): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const netstat = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const raw of netstat.split('\n')) {
      const line = raw.trim();
      if (!/LISTENING/i.test(line)) continue;
      if (line.includes(`:${port} `) || line.includes(`:${port}\t`)) return true;
    }
  } catch {
    /* if netstat itself fails, miss the wedge rather than crash startup */
  }
  return false;
}

// Find the PID listening on `port` and SIGKILL/taskkill it. Windows-only —
// POSIX rarely needs this and `lsof | xargs kill -9` against the wrong PID
// is a worse failure mode than the original symptom. Best-effort: any
// failure (no listener, parse miss, taskkill rc != 0) is logged and
// swallowed so the calling spawn gets to try.
async function forceKillByPort(port: number): Promise<void> {
  if (process.platform !== 'win32') return;
  let netstat: string;
  try {
    netstat = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    console.warn(
      `[lattice-backend] netstat failed during force-kill: ${(err as Error).message}`,
    );
    return;
  }
  const pids = new Set<string>();
  for (const raw of netstat.split('\n')) {
    const line = raw.trim();
    if (!/LISTENING/i.test(line)) continue;
    // "TCP   127.0.0.1:5185   0.0.0.0:0   LISTENING   12345"
    if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
    const pid = line.split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  if (pids.size === 0) return;
  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, {
        windowsHide: true,
        stdio: 'ignore',
      });
      console.warn(
        `[lattice-backend] force-killed orphan terminal-server pid ${pid} on port ${port}`,
      );
    } catch (err) {
      console.warn(
        `[lattice-backend] taskkill /F /PID ${pid} failed: ${(err as Error).message}`,
      );
    }
  }
  // Brief pause so Windows releases the listener before the next bind.
  await new Promise<void>((r) => setTimeout(r, 500));
}

// Singleton: concurrent callers share one startup attempt instead of each
// spawning a separate process that fights for port 5185.
let starting: Promise<void> | null = null;

async function spawnAndWait(): Promise<void> {
  const script = path.join(__dirname, 'terminal-server.js');
  // LATTICE_API_PORT is forwarded so the detached terminal-server (which
  // doesn't otherwise know the main backend's port) can stamp the right URL
  // into the LATTICE_API_URL env var it injects on every pty spawn.
  const apiPort = Number(process.env.PORT) || 5184;
  const child = spawn(process.execPath, [script], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TERMINAL_PORT: String(TERMINAL_PORT),
      LATTICE_API_PORT: String(apiPort),
    },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 100));
    if ((await probeServer()) === 'ok') {
      console.log(
        `[lattice-backend] terminal server started on port ${TERMINAL_PORT}`,
      );
      return;
    }
  }
  console.error(
    '[lattice-backend] terminal server did not start in 5 s — terminals unavailable',
  );
}

// Ensures a *current-version* terminal server is running. If a stale one
// (older API version) is responding on the port, shut it down first so a
// fresh spawn can take over.
export async function ensureTerminalServer(): Promise<void> {
  const status = await probeServer();
  if (status === 'ok') return;
  if (!starting) {
    starting = (async () => {
      if (status === 'stale') {
        console.warn(
          `[lattice-backend] stale terminal-server detected (fingerprint mismatch; expected ${EXPECTED_TERMINAL_FINGERPRINT}) — shutting down and respawning`,
        );
        await shutdownStale();
      } else if (isPortListening(TERMINAL_PORT)) {
        // probeServer returned 'dead' (no usable /health response within
        // 500 ms) but the port is bound — almost always a previous
        // terminal-server whose event loop is wedged enough that /health
        // times out. Without this branch the next spawnAndWait
        // EADDRINUSE-crashes silently (stdio: 'ignore') and we log the
        // confusing "did not start in 5 s" while the orphan keeps holding
        // the port forever. Force-kill matches what shutdownStale does as
        // its fallback for unresponsive stale orphans.
        console.warn(
          `[lattice-backend] port ${TERMINAL_PORT} bound but /health unresponsive — force-killing orphan terminal-server before spawn`,
        );
        await forceKillByPort(TERMINAL_PORT);
      }
      await spawnAndWait();
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

// Proxies a terminal WebSocket from the UI through to the terminal server.
// Bidirectional relay; either side closing tears down both ends.
export function proxyTerminalWs(
  clientWs: WebSocket,
  reqUrl: string | undefined,
) {
  const params = new URL(reqUrl ?? '', 'http://localhost').searchParams;
  const targetWs = new WebSocket(
    `ws://127.0.0.1:${TERMINAL_PORT}/ws/terminal?${params.toString()}`,
  );

  // Buffer messages that arrive before the upstream connection is open.
  const pending: Array<{ data: RawData; isBinary: boolean }> = [];

  clientWs.on('message', (data: RawData, isBinary: boolean) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
    } else {
      pending.push({ data, isBinary });
    }
  });

  targetWs.on('open', () => {
    for (const { data, isBinary } of pending) {
      try {
        targetWs.send(data, { binary: isBinary });
      } catch {
        /* upstream dropped between open and flush — discard */
      }
    }
    pending.length = 0;
  });

  targetWs.on('message', (data: RawData, isBinary: boolean) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  targetWs.on('error', (err) => {
    console.error('[terminal-proxy] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  targetWs.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('close', () => {
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });

  clientWs.on('error', () => {
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });
}

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
export async function proxyCreateSession(opts: {
  cwd?: string;
  initialCommand?: string;
  projectPath?: string;
  cols?: number;
  rows?: number;
}): Promise<{ id: string } | { error: string }> {
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

type CreateOnce =
  | { id: string }
  | { error: string; recoverable: boolean };

async function tryCreateSessionOnce(
  opts: Parameters<typeof proxyCreateSession>[0],
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

async function respawn(): Promise<void> {
  await shutdownStale();
  // Reset the singleton so ensureTerminalServer actually spawns again
  // instead of awaiting an already-resolved no-op promise.
  starting = null;
  await ensureTerminalServer();
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
