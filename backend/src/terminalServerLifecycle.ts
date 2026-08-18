import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceKillByPort } from './forceKillByPort.js';
import { computeTerminalFingerprint } from './terminalFingerprint.js';
import {
  getTerminalServerAuthToken,
  terminalServerAuthHeaders,
  TERMINAL_SERVER_TOKEN_ENV,
} from './terminalServerAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 5185;
export const BASE = `http://127.0.0.1:${TERMINAL_PORT}`;

// Content-hash of the terminal-server's runtime files, computed from the
// SAME files the spawned terminal-server hashes itself. A running server
// whose fingerprint differs from this one is built from older bytes and
// must be respawned. No manual version constant to forget to bump.
export const EXPECTED_TERMINAL_FINGERPRINT = computeTerminalFingerprint();

// Timeouts / poll intervals for talking to the detached terminal-server.
const PROBE_TIMEOUT_MS = 500; // /health liveness probe
const SHUTDOWN_STALE_TIMEOUT_MS = 1000; // POST /shutdown to a stale server
const SHUTDOWN_POLL_INTERVAL_MS = 150; // poll waiting for the stale server to die
const SPAWN_WAIT_POLL_INTERVAL_MS = 100; // poll waiting for the fresh server to come up

export type ProbeResult = 'ok' | 'stale' | 'dead';

export async function probeServer(): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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

export async function shutdownStale(): Promise<void> {
  // The /shutdown endpoint exists on newer servers; older ones 404 it.
  // Either way we best-effort the call and then poll for port release.
  try {
    await fetch(`${BASE}/shutdown`, {
      method: 'POST',
      headers: terminalServerAuthHeaders(),
      signal: AbortSignal.timeout(SHUTDOWN_STALE_TIMEOUT_MS),
    });
  } catch {
    /* old server may already be dying or never had the endpoint */
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, SHUTDOWN_POLL_INTERVAL_MS));
    if ((await probeServer()) === 'dead') return;
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

// Singleton: concurrent callers share one startup attempt instead of each
// spawning a separate process that fights for port 5185.
let starting: Promise<void> | null = null;

export async function spawnAndWait(): Promise<void> {
  const script = path.join(__dirname, 'terminal-server.js');
  // LATTICE_API_PORT is forwarded so the detached terminal-server (which
  // doesn't otherwise know the main backend's port) can stamp the right URL
  // into the `.lattice/LATTICE_API.md` it regenerates on every pty spawn.
  const apiPort = Number(process.env.PORT) || 5184;
  // BACKEND_PARENT_PID lets the detached terminal-server self-terminate
  // when the backend that spawned it is gone (orchestrator shell closed,
  // Task Manager kill, OS reboot interrupt). Without this, the orphan
  // outlives the backend indefinitely — same content fingerprint as the
  // next boot, so the lifecycle check treats it as "healthy" and reuses
  // a process that may be wedged. We use `process.ppid` so dev-runner
  // restarts of `dist/index.js` (whose PID changes) don't re-trigger the
  // termination — only the orchestrator going away does.
  const parentPid = process.ppid || process.pid;
  const terminalAuthToken = getTerminalServerAuthToken();
  const child = spawn(process.execPath, [script], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TERMINAL_PORT: String(TERMINAL_PORT),
      LATTICE_API_PORT: String(apiPort),
      BACKEND_PARENT_PID: String(parentPid),
      [TERMINAL_SERVER_TOKEN_ENV]: terminalAuthToken,
    },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, SPAWN_WAIT_POLL_INTERVAL_MS));
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
      }
      await spawnAndWait();
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export async function respawn(): Promise<void> {
  await shutdownStale();
  // Reset the singleton so ensureTerminalServer actually spawns again
  // instead of awaiting an already-resolved no-op promise.
  starting = null;
  await ensureTerminalServer();
}
