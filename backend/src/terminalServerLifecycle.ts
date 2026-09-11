import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTerminalFingerprint } from './terminalFingerprint.js';
import { TERMINAL_PROTOCOL_VERSION, type TerminalServerInfo } from './terminalProtocol.js';
import { getTerminalServerAuthToken, terminalServerAuthHeaders, TERMINAL_SERVER_TOKEN_ENV } from './terminalServerAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 5185;
export const BASE = `http://127.0.0.1:${TERMINAL_PORT}`;
export const EXPECTED_TERMINAL_FINGERPRINT = computeTerminalFingerprint();

export type TerminalProbe =
  | { kind: 'ready'; info: TerminalServerInfo }
  | { kind: 'absent' }
  | { kind: 'unavailable'; error: string };
export type ProbeResult = 'ok' | 'stale' | 'dead' | 'unknown';

// Refusal proves absence; timeouts, resets and HTML prove only uncertainty.
function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; cause?: unknown; errors?: unknown[] };
  if (value.code === 'ECONNREFUSED') return true;
  if (value.cause) return connectionRefused(value.cause);
  return Array.isArray(value.errors) && value.errors.length > 0 && value.errors.every(connectionRefused);
}

function launchTerminalServer(): ChildProcess {
  return spawn(process.execPath, [path.join(__dirname, 'terminal-server.js')], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: {
      ...process.env, TERMINAL_PORT: String(TERMINAL_PORT),
      LATTICE_API_PORT: String(Number(process.env.PORT) || 5184),
      // Stable across dev-runner restarts of the main backend.
      BACKEND_PARENT_PID: String(process.ppid || process.pid),
      [TERMINAL_SERVER_TOKEN_ENV]: getTerminalServerAuthToken(),
    },
  });
}

type LifecycleDeps = {
  fetch: typeof fetch; launch: () => ChildProcess;
  sleep: (ms: number) => Promise<void>; now: () => number;
  base: string; fingerprint: string; startupTimeoutMs: number; shutdownTimeoutMs: number;
};

/** Injected lifecycle fixtures never spawn or kill a real terminal server. */
export function createTerminalLifecycle(overrides: Partial<LifecycleDeps> = {}) {
  const deps: LifecycleDeps = {
    fetch: (...args) => fetch(...args), launch: launchTerminalServer,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: Date.now,
    base: BASE, fingerprint: EXPECTED_TERMINAL_FINGERPRINT,
    startupTimeoutMs: 5000, shutdownTimeoutMs: 3000, ...overrides,
  };
  let starting: Promise<TerminalServerInfo> | null = null;
  let lastDeferred = '';

  async function probe(): Promise<TerminalProbe> {
    try {
      const response = await deps.fetch(`${deps.base}/health`, { signal: AbortSignal.timeout(500) });
      if (!response.ok) return { kind: 'unavailable', error: `health returned HTTP ${response.status}` };
      const body = await response.json() as Record<string, unknown> | null;
      if (!body || body.ok !== true || typeof body.fingerprint !== 'string' || !body.fingerprint) {
        return { kind: 'unavailable', error: 'listener did not identify itself as a Lattice terminal server' };
      }
      // Fingerprint-only servers predate safe idle upgrades. Their existing
      // session API remains usable; never send them unconditional shutdown.
      if (body.protocolVersion === undefined) return { kind: 'ready', info: { fingerprint: body.fingerprint } };
      const caps = body.capabilities as Record<string, unknown> | null;
      if (body.protocolVersion !== TERMINAL_PROTOCOL_VERSION || typeof body.instanceId !== 'string'
          || !body.instanceId || !caps || caps.idempotentCreate !== true || caps.shutdownIfIdle !== true) {
        return { kind: 'unavailable', error: 'terminal server uses an unsupported protocol; existing terminals were preserved' };
      }
      return { kind: 'ready', info: {
        fingerprint: body.fingerprint, instanceId: body.instanceId,
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        capabilities: { idempotentCreate: true, shutdownIfIdle: true },
      } };
    } catch (error) {
      return connectionRefused(error) ? { kind: 'absent' }
        : { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function shutdownIfIdle(info: TerminalServerInfo): Promise<boolean> {
    if (!info.capabilities?.shutdownIfIdle || !info.instanceId) return false;
    const response = await deps.fetch(`${deps.base}/shutdown-if-idle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...terminalServerAuthHeaders() },
      body: JSON.stringify({ instanceId: info.instanceId }), signal: AbortSignal.timeout(1000),
    });
    const body = await response.json() as { ok?: boolean; busy?: boolean; instanceId?: string };
    if (response.status === 409 && body.busy === true) return false;
    if (response.status !== 202 || body.ok !== true || body.instanceId !== info.instanceId) {
      throw new Error('terminal server refused safe idle upgrade; existing terminals were preserved');
    }
    const deadline = deps.now() + deps.shutdownTimeoutMs;
    while (deps.now() < deadline) {
      await deps.sleep(150);
      const status = await probe();
      if (status.kind === 'absent') return true;
      // Another backend may already have replaced the idle executor. The
      // caller probes again before spawning and adopts it if compatible.
      if (status.kind === 'ready' && status.info.instanceId !== info.instanceId) return true;
    }
    throw new Error('terminal server idle shutdown did not finish; no process was force-killed');
  }

  async function spawnAndWait(): Promise<TerminalServerInfo> {
    const child = deps.launch();
    let childFailure: Error | null = null;
    // Retain the error listener after startup too: ChildProcess errors must
    // never bubble into the backend's fatal process guard.
    child.on('error', (error) => { childFailure = error; });
    child.once('exit', (code, signal) => {
      childFailure = new Error(`terminal server exited before startup (code ${code}, signal ${signal})`);
    });
    child.unref();
    const deadline = deps.now() + deps.startupTimeoutMs;
    while (deps.now() < deadline) {
      await deps.sleep(100);
      const status = await probe();
      if (status.kind === 'ready') {
        console.log(`[lattice-backend] terminal server ready at ${deps.base}`);
        return status.info;
      }
      // A second backend may win the bind race; adopt its compatible executor
      // before treating our child's EADDRINUSE exit as a startup failure.
      if (childFailure) throw childFailure;
    }
    throw new Error(`terminal server did not start within ${deps.startupTimeoutMs}ms; terminals unavailable`);
  }

  async function performEnsure(): Promise<TerminalServerInfo> {
    let status = await probe();
    if (status.kind === 'unavailable') throw new Error(`Terminal server unavailable: ${status.error}`);
    if (status.kind === 'ready') {
      const info = status.info;
      if (info.fingerprint === deps.fingerprint) return info;
      if (!await shutdownIfIdle(info)) {
        const key = info.instanceId ?? info.fingerprint;
        if (key !== lastDeferred) {
          lastDeferred = key;
          console.warn('[lattice-backend] terminal-server update deferred; reusing existing executor to preserve terminals');
        }
        return info;
      }
      status = await probe();
      if (status.kind === 'ready') return status.info;
      if (status.kind === 'unavailable') throw new Error(`Terminal server unavailable after idle upgrade: ${status.error}`);
    }
    return spawnAndWait();
  }

  function ensure(): Promise<TerminalServerInfo> {
    if (!starting) starting = performEnsure().finally(() => { starting = null; });
    return starting;
  }
  // Repair obeys the same preservation rules and shares the startup singleton.
  return { ensure, respawn: ensure, probe, spawnAndWait, shutdownIfIdle };
}

const lifecycle = createTerminalLifecycle();
export const ensureTerminalServer = lifecycle.ensure;
export const respawn = lifecycle.respawn;
export const spawnAndWait = lifecycle.spawnAndWait;
export const probeTerminalServer = lifecycle.probe;
export const shutdownStale = lifecycle.shutdownIfIdle;
export async function probeServer(): Promise<ProbeResult> {
  const result = await lifecycle.probe();
  return result.kind === 'absent' ? 'dead' : result.kind === 'unavailable' ? 'unknown'
    : result.info.fingerprint === EXPECTED_TERMINAL_FINGERPRINT ? 'ok' : 'stale';
}
