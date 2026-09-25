import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The dev-runner log lives with the rest of the crash bookkeeping, in the root
// orchestrator's helpers. This runner is a SECOND supervisor — the orchestrator
// only ever sees `backend/scripts/dev.mjs` (this process), never the
// `dist/index.js` it spawns — so without recording here, the death of the one
// process that actually crashes goes unwritten. That is precisely how the
// 2026-08-20 access violation escaped every log Lattice keeps.
import { recordExit } from '../../../scripts/orchestrate/devLog.mjs';
import { inheritStdio } from './deps.mjs';
import { describeExitCode, isHardFault } from './exitStatus.mjs';
import { clearLiveLog } from './liveLog.mjs';

export const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 5185;
// Mirrors backend/src/server/config.ts — the port dist/index.js binds.
export const BACKEND_PORT = Number(process.env.PORT) || 5184;
// A backend that dies this soon after spawn died at boot, not mid-flight.
export const BOOT_DEATH_WINDOW_MS = 30 * 1000;
// Respawn delays after the backend exits ON ITS OWN (a crash, a fatal startup
// error, an external kill). It used to wait for the next dist/ change, so one
// transient crash — or a boot that lost a race for port 5184 with a backend
// still shutting down — left Lattice down until someone saved a file. The
// first delay is deliberately not zero: on Windows Ctrl+C reaches dist/index.js
// too, and its exit can be observed a moment BEFORE this runner's own signal
// handler marks the shutdown; 2 s is ample for that to land (the timer then
// sees the shutdown and spawns nothing). Past the list, keep retrying at the
// last delay. A dist/ change still retries immediately.
export const CRASH_RESPAWN_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
// A backend that stayed up this long before dying was healthy: its death
// starts the backoff over from the first delay.
export const CRASH_STABLE_UPTIME_MS = 5 * 60 * 1000;

export function crashRespawnDelayMs(attempt, delays = CRASH_RESPAWN_DELAYS_MS) {
  const i = Math.max(0, Math.min(attempt, delays.length - 1));
  return delays[i];
}

// Is something listening on the backend's port right now? The backend's
// stdio is inherited (this runner never sees its output), and a startup
// `EADDRINUSE` is caught in index.ts → `process.exit(1)`, which writes no
// crash file and retracts the live-log mirror — so the port itself is the
// only evidence this process can gather that another process holds it.
export function probeBackendPort(port = BACKEND_PORT, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (held) => {
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function portHeldHint(port = BACKEND_PORT, platform = process.platform) {
  const find = platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -i :${port}`;
  return `port ${port} is held by another process — find it with \`${find}\``;
}

export function createBackendLifecycle({
  copyAssetsBeforeRespawn,
  isShuttingDown,
  onExitDuringShutdown,
  stdio = inheritStdio,
  spawnProcess = spawn,
  canSpawnBackend = () => true,
  onBackendSpawned = () => {},
  captureBackendVersion = () => undefined,
  probePort = probeBackendPort,
  now = () => Date.now(),
  crashRespawnDelaysMs = CRASH_RESPAWN_DELAYS_MS,
  crashStableUptimeMs = CRASH_STABLE_UPTIME_MS,
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Never keep the runner alive just to retry a dead backend.
    t.unref?.();
    return t;
  },
  clearTimer = (t) => clearTimeout(t),
}) {
  let backendChild = null;
  let restartingBackend = false; // true between a restart kill and the respawn
  let crashRespawnTimer = null; // pending automatic respawn after a crash
  let crashAttempt = 0; // consecutive crashes without a stable uptime between

  function cancelCrashRespawn() {
    if (crashRespawnTimer === null) return;
    clearTimer(crashRespawnTimer);
    crashRespawnTimer = null;
  }

  function scheduleCrashRespawn(uptimeMs) {
    if (isShuttingDown()) return null;
    if (uptimeMs >= crashStableUptimeMs) crashAttempt = 0;
    const delay = crashRespawnDelayMs(crashAttempt, crashRespawnDelaysMs);
    crashAttempt += 1;
    const attempt = crashAttempt;
    cancelCrashRespawn();
    crashRespawnTimer = setTimer(() => {
      crashRespawnTimer = null;
      // Shutdown wins; a dist/ change (restartBackend) may already have
      // started a backend while we waited.
      if (isShuttingDown() || backendChild) return;
      if (!canSpawnBackend()) {
        console.error(
          '[lattice-backend] not respawning dist/index.js yet — TypeScript is compiling or has errors; ' +
            'the next successful compile starts it',
        );
        return;
      }
      console.log(`[lattice-backend] respawning dist/index.js after it exited (attempt ${attempt})`);
      backendChild = spawnBackend();
    }, delay);
    return delay;
  }

  function spawnBackend() {
    if (isShuttingDown() || !canSpawnBackend()) return null;
    cancelCrashRespawn();
    copyAssetsBeforeRespawn();
    const version = captureBackendVersion();
    restartingBackend = false;
    const c = spawnProcess(process.execPath, ['dist/index.js'], { stdio });
    const spawnedAt = now();
    let finished = false;
    let spawned = false;
    c.once('spawn', () => { spawned = true; onBackendSpawned(version); });
    function onChildExit(code, signal, spawnError) {
      if (finished) return;
      finished = true;
      // A death we asked for runs no JS in the child on Windows (`kill()` is
      // TerminateProcess), so the child cannot retract its own live console
      // mirror — we do it for it, or the next boot reports this as a crash.
      // Preserve unexpected non-zero/signal exits too: an external kill does
      // not have to use a native fault code. See liveLog.mjs.
      if (restartingBackend || isShuttingDown() || (code === 0 && !signal)) clearLiveLog(c.pid);
      if (isShuttingDown()) {
        restartingBackend = false;
        backendChild = null;
        recordExit('lattice-backend', code ?? 0, { expected: true });
        void onExitDuringShutdown(code ?? 0);
        return;
      }
      if (restartingBackend) {
        restartingBackend = false;
        backendChild = spawnBackend();
        return;
      }
      // Exited on its own (a crash, or a fatal startup error) — respawn it
      // after a backoff (CRASH_RESPAWN_DELAYS_MS); a dist/ change still
      // retries at once. A boot failure that repeats (EADDRINUSE while another
      // backend holds the port, a broken build) just walks the backoff out to
      // one attempt a minute rather than spinning.
      //
      // Record it before anything else. The backend writes its own crash file
      // for faults it is alive to observe (backend/src/crashLog.ts), but a hard
      // fault, an OS OOM-kill or an external `taskkill` runs no JS in that
      // process at all — this handler, in a different process, is the only
      // thing that still gets to write the death down.
      const cause = spawnError ? `spawn failed: ${spawnError.message}` : describeExitCode(code, signal);
      backendChild = null;
      const respawnInMs = scheduleCrashRespawn(now() - spawnedAt);
      const record = (hint) => {
        const detail = hint ? `${cause}; ${hint}` : cause;
        const log = recordExit('lattice-backend', code ?? 0, { detail });
        console.error(
          `[lattice-backend] dist/index.js exited (${cause}) — ` +
            (respawnInMs === null
              ? 'waiting for a dist/ change to retry...'
              : `retrying in ${Math.round(respawnInMs / 1000)} s (sooner on a dist/ change)...`),
        );
        if (hint) console.error(`[lattice-backend] ${hint}`);
        if (isHardFault(code)) {
          console.error(
            '[lattice-backend] that was an OS-level fault, not a JS exception — the backend could not ' +
              'log it from the inside. Its last console lines are in the newest ' +
              '~/.lattice/logs/crash-*-nojs.log.',
          );
        }
        if (log) console.error(`[lattice-backend] exit recorded to ${log}`);
      };
      // A non-zero death within seconds of spawn is a boot failure. The one
      // boot failure this runner can diagnose from the outside is a port
      // already in use — probe it (≤ 1 s) so the record names the cause,
      // instead of reading exactly like a code crash. Skip the hint if a
      // newer backend of ours was spawned meanwhile (it would answer the probe).
      const bootDeath = !spawnError && code !== 0 && now() - spawnedAt < BOOT_DEATH_WINDOW_MS;
      if (!bootDeath) {
        record('');
        return;
      }
      Promise.resolve()
        .then(() => probePort(BACKEND_PORT))
        .then((held) => record(held && backendChild === null ? portHeldHint(BACKEND_PORT) : ''))
        .catch(() => record(''));
    }
    c.on('exit', (code, signal) => onChildExit(code, signal));
    c.on('error', (err) => {
      if (!spawned) onChildExit(1, null, err);
      else {
        // kill() can fail asynchronously too. The old process may still be
        // serving; do not forget it and admit a duplicate backend.
        restartingBackend = false;
        console.error('[lattice-backend] backend child operation failed:', err);
      }
    });
    return c;
  }

  function start() {
    backendChild = spawnBackend();
  }

  function restartBackend(reason) {
    if (isShuttingDown() || !canSpawnBackend()) return false;
    if (restartingBackend) return false; // a restart is already in flight
    if (!backendChild) {
      console.log(`[lattice-backend] starting dist/index.js — ${reason}`);
      backendChild = spawnBackend();
      return true;
    }
    console.log(`[lattice-backend] restarting dist/index.js — ${reason}`);
    restartingBackend = true;
    try {
      backendChild.kill();
    } catch (err) {
      restartingBackend = false;
      console.error('[lattice-backend] could not stop backend for restart:', err);
      return false;
    }
    return true;
  }

  function kill(signal) {
    // Real shutdown: a pending crash respawn must not bring a backend back.
    cancelCrashRespawn();
    if (!backendChild) return;
    try {
      backendChild.kill(signal);
    } catch {
      /* ignore */
    }
  }

  return {
    start,
    restartBackend,
    kill,
    needsStart: () => !backendChild,
    crashRespawnPending: () => crashRespawnTimer !== null,
  };
}

// The terminal server (port 5185) is intentionally detached + unref'd by
// the backend (terminalProxy.ts) so PTYs survive backend restarts. The
// downside is the orchestrator killing the backend doesn't take it down,
// so on real shutdown we POST /shutdown ourselves. (NOT on a plain
// restart — that would kill every PTY on each HMR cycle.) Without this,
// every `npm run dev` cycle leaves orphan PTYs (and orphan Claude Code
// processes inside them) running forever.
export async function shutdownTerminalServer(terminalPort = TERMINAL_PORT) {
  try {
    // Read the backend's persisted token; the dev runner must not create or
    // rotate it while shutting down an existing detached server.
    const token = fs.readFileSync(
      path.join(os.homedir(), '.lattice', 'terminalServerToken'), 'utf8',
    ).trim();
    const res = await fetch(`http://127.0.0.1:${terminalPort}/shutdown`, {
      method: 'POST',
      headers: { 'x-lattice-terminal-token': token },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) console.warn(`[lattice-backend] terminal-server shutdown failed: HTTP ${res.status}`);
  } catch {
    /* terminal server already down */
  }
}
