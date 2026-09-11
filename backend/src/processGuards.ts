// Last-resort process-level guards.
//
// node-pty on Windows has a known bug in its cleanup path: when a pty is
// killed and the conpty_console_list_agent helper subprocess fails to
// AttachConsole (which happens routinely on Windows shells that have
// already exited), node-pty's main code does
//   consoleProcessList.forEach(...)
// at windowsPtyAgent.js:141 with consoleProcessList === undefined. The
// throw fires asynchronously past any try/catch around pty.kill(), so it
// surfaces as an uncaughtException and crashes the whole backend — taking
// every other terminal session with it. The pty itself does die fine; the
// failed cleanup is purely cosmetic. Swallow ONLY that node-pty error here.
//
// Everything else is a real bug. Installing an uncaughtException /
// unhandledRejection handler disables Node's default "print + exit non-zero"
// crash behaviour, so if we merely logged and returned we'd leave the backend
// running in an undefined post-exception state — masking the very failures
// this comment promises still surface. Instead we log and then fail fast
// (exit 1) so the dev runner / user restarts a clean process.

import { flushSinksSyncIfIdle, hasWriteInFlight } from './consoleSink.js';
import { installCrashLogging, writeCrashLog } from './crashLog.js';
import { isNodePtyCleanupFailure } from './nodePtyCleanupFailure.js';

const FATAL_EXIT_DELAY_MS = 10;

// Preserve Node's fail-fast contract for a genuine programming error: set the
// exit code immediately (so even a natural exit is non-zero) and force-exit on
// a later tick, giving the just-written stderr a moment to flush first. The
// crash file is written first, synchronously — the user's console scrollback is
// the only other record and it goes away with their terminal.
// Persist the crash (and tell the user where it went) before we exit.
function reportFatal(kind: string, errOrReason: unknown): void {
  const file = writeCrashLog(kind, errOrReason);
  if (file) console.error(`[lattice] crash log written to ${file}`);
}

function crashAfterStderrFlush(): void {
  process.exitCode = 1;
  setTimeout(() => {
    // Console output is queued on the thread pool now (consoleSink.ts), and
    // `process.exit` drops whatever hasn't been written yet. Push it out
    // synchronously first — skipped if the console is stalled, since blocking
    // here would hang a process that is trying to die.
    flushSinksSyncIfIdle();
    // And if a write IS stalled, `process.exit` itself never returns: libuv
    // joins its thread pool from an atexit handler, and that thread is parked
    // inside the write until the console resumes. A backend that can't die
    // holds port 5184 and never gets respawned, so take the hard exit. The
    // crash file is already on disk; there is nothing left to flush.
    if (hasWriteInFlight()) process.kill(process.pid, 'SIGKILL');
    else process.exit(1);
  }, FATAL_EXIT_DELAY_MS);
}

export function installProcessGuards(): void {
  installCrashLogging('backend');

  process.on('uncaughtException', (err) => {
    if (isNodePtyCleanupFailure(err)) {
      console.warn(
        '[lattice] swallowed node-pty error (pty cleanup, not fatal):',
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.error('[lattice] uncaughtException', err);
    reportFatal('uncaughtException', err);
    crashAfterStderrFlush();
  });

  process.on('unhandledRejection', (reason) => {
    if (isNodePtyCleanupFailure(reason)) {
      console.warn(
        '[lattice] swallowed node-pty rejection:',
        reason instanceof Error ? reason.message : reason,
      );
      return;
    }
    console.error('[lattice] unhandledRejection', reason);
    reportFatal('unhandledRejection', reason);
    crashAfterStderrFlush();
  });
}
