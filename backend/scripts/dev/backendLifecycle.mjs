import { spawn } from 'node:child_process';

import { inheritStdio } from './deps.mjs';

export const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 5185;

export function createBackendLifecycle({
  copyAssetsBeforeRespawn,
  isShuttingDown,
  onExitDuringShutdown,
  stdio = inheritStdio,
}) {
  let backendChild = null;
  let restartingBackend = false; // true between a restart kill and the respawn

  function spawnBackend() {
    copyAssetsBeforeRespawn();
    restartingBackend = false;
    const c = spawn(process.execPath, ['dist/index.js'], { stdio });
    c.on('exit', (code, signal) => {
      if (restartingBackend) {
        restartingBackend = false;
        backendChild = spawnBackend();
        return;
      }
      if (isShuttingDown()) {
        void onExitDuringShutdown(code ?? 0);
        return;
      }
      // Exited on its own (a crash, or a fatal startup error) — mirror
      // `node --watch`: stay up and wait for the next dist/ change to retry.
      console.error(
        `[lattice-backend] dist/index.js exited (${signal ? `signal ${signal}` : `code ${code}`}) — ` +
          `waiting for a dist/ change to retry...`,
      );
      backendChild = null;
    });
    return c;
  }

  function start() {
    backendChild = spawnBackend();
  }

  function restartBackend(reason) {
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
    } catch {
      restartingBackend = false;
      backendChild = spawnBackend();
    }
    return true;
  }

  function kill(signal) {
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
    await fetch(`http://127.0.0.1:${terminalPort}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* terminal server already down */
  }
}
