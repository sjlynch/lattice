import { spawn } from 'node:child_process';

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
      // A death we asked for runs no JS in the child on Windows (`kill()` is
      // TerminateProcess), so the child cannot retract its own live console
      // mirror — we do it for it, or the next boot reports this as a crash.
      // A hard fault is the one case we deliberately leave behind: that mirror
      // is the only surviving record of what it was doing. See liveLog.mjs.
      if (!isHardFault(code)) clearLiveLog(c.pid);
      if (restartingBackend) {
        restartingBackend = false;
        backendChild = spawnBackend();
        return;
      }
      if (isShuttingDown()) {
        recordExit('lattice-backend', code ?? 0, { expected: true });
        void onExitDuringShutdown(code ?? 0);
        return;
      }
      // Exited on its own (a crash, or a fatal startup error) — mirror
      // `node --watch`: stay up and wait for the next dist/ change to retry.
      //
      // Record it before anything else. The backend writes its own crash file
      // for faults it is alive to observe (backend/src/crashLog.ts), but a hard
      // fault, an OS OOM-kill or an external `taskkill` runs no JS in that
      // process at all — this handler, in a different process, is the only
      // thing that still gets to write the death down.
      const cause = describeExitCode(code, signal);
      const log = recordExit('lattice-backend', code ?? 0, { detail: cause });
      console.error(
        `[lattice-backend] dist/index.js exited (${cause}) — ` +
          `waiting for a dist/ change to retry...`,
      );
      if (isHardFault(code)) {
        console.error(
          '[lattice-backend] that was an OS-level fault, not a JS exception — the backend could not ' +
            'log it from the inside. Its last console lines are in the newest ' +
            '~/.lattice/logs/crash-*-nojs.log.',
        );
      }
      if (log) console.error(`[lattice-backend] exit recorded to ${log}`);
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
