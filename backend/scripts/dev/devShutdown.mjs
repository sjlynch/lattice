// The dev runner's stop sequence (dev.mjs), pulled out so it can be tested
// with injected collaborators.
//
// Two kinds of stop share it:
//   - a REAL stop (Ctrl+C / SIGTERM): everything goes, the terminal-server
//     `/shutdown` included, and the backend is killed at once.
//   - the SOFT stop (`keepTerminals`, the dev console's `r` / `d`): everything
//     goes EXCEPT the terminal-server, whose sessions the next backend
//     re-adopts exactly as after a dist/ restart (killing dist/index.js is a
//     plain TerminateProcess, never a tree kill, so the detached server it
//     once spawned is not taken with it). Because the kill runs no JS in the
//     backend, a soft stop first asks it to DRAIN — the same handshake the
//     automatic restart path uses (restartHandshake.mjs): no new work, in-flight
//     transitions land, debounced task / run-mirror writes flushed. Fail open,
//     on a budget short enough to fit inside the orchestrator's
//     SOFT_STOP_TIMEOUT_MS.
// A real stop arriving during a soft one (Ctrl+C right after `r`) still sends
// the `/shutdown`, and cuts a drain still in progress short.

export function createDevShutdown({
  // Stop every watcher / timer that could restart the backend under us.
  stopWatchers,
  // Stop the tsc -w compiler.
  stopCompiler,
  // The terminal-server `/shutdown`; the caller makes it send-once.
  shutdownTerminals,
  // → Promise<{ok, ready, pending, waitedMs} | {ok:false, why}>; never rejects
  // in practice, but a throw is treated as "unavailable" (fail open).
  prepareDrain,
  killBackend,
  // True when no backend is running (crashed, never started).
  needsBackendStart,
  // Called when there is no backend whose exit would finish the stop.
  onNoBackend,
  log = (msg) => console.log(msg),
  warn = (msg) => console.warn(msg),
}) {
  let shutdownDone = null;
  let shuttingDown = false;
  // Resolves a soft stop's drain wait early when a real stop arrives.
  let cutDrainShort = null;

  async function drainBeforeSoftStop() {
    if (!prepareDrain || needsBackendStart()) return;
    log('[lattice-backend] soft stop — asking the backend to drain first...');
    const hardStop = new Promise((resolve) => {
      cutDrainShort = () => resolve({ ok: false, why: 'a full stop arrived during the drain', hardStop: true });
    });
    const prepared = Promise.resolve()
      .then(() => prepareDrain('soft stop'))
      .then(
        (result) => result,
        (err) => ({ ok: false, why: `handshake threw: ${err?.message ?? err}` }),
      );
    const result = await Promise.race([prepared, hardStop]);
    cutDrainShort = null;
    if (result?.hardStop) {
      warn(`[lattice-backend] ${result.why} — stopping the backend without waiting for it`);
    } else if (!result || !result.ok) {
      warn(
        `[lattice-backend] restart handshake unavailable (${result?.why ?? 'no answer'}) — ` +
          'stopping without draining the backend',
      );
    } else if (!result.ready) {
      warn(
        `[lattice-backend] backend did not settle within ${Math.round(result.waitedMs / 1000)} s ` +
          `(still in flight: ${result.pending.join('; ') || 'unknown'}) — stopping anyway`,
      );
    } else {
      log(`[lattice-backend] backend drained for the soft stop in ${result.waitedMs} ms`);
    }
  }

  function shutdown(signal, { keepTerminals = false } = {}) {
    if (!shutdownDone) {
      shuttingDown = true;
      shutdownDone = (async () => {
        stopWatchers();
        stopCompiler(signal);
        if (keepTerminals) await drainBeforeSoftStop();
        else await shutdownTerminals();
        killBackend(signal);
        // No backend to wait for (it crashed and is waiting for a dist/ change):
        // nothing will report its exit, and the control pipe keeps this
        // process up. Deferred a turn: this body can finish synchronously,
        // before `shutdownDone` is even assigned.
        if (needsBackendStart()) setImmediate(() => void onNoBackend());
      })();
    }
    if (!keepTerminals) {
      cutDrainShort?.();
      void shutdownTerminals();
    }
    return shutdownDone;
  }

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
    // The in-flight stop, or null before one began.
    done: () => shutdownDone,
  };
}
