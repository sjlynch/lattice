// Same node-pty Windows cleanup guard as the main server. Must be registered
// before any PTY session can throw asynchronously.
//
// Swallow ONLY the known-cosmetic node-pty cleanup throw (see the main
// server's processGuards.ts for the full description). Every other uncaught
// exception / unhandled rejection is a real bug: installing these handlers
// disables Node's default fail-fast crash, so we log and then exit non-zero
// rather than leave this detached terminal-server running in an undefined
// state. The main backend respawns it on demand.
//
// This process is spawned with `stdio: 'ignore'`, so its console output goes
// nowhere at all — the crash file under ~/.lattice/logs/ is the ONLY record a
// terminal-server crash leaves behind.

import { installCrashLogging, writeCrashLog } from '../crashLog.js';
import { isNodePtyCleanupFailure } from '../nodePtyCleanupFailure.js';

const FATAL_EXIT_DELAY_MS = 10;

// Set the exit code immediately, then force-exit on a later tick so the
// just-written stderr has a moment to flush before we go down.
function crashAfterStderrFlush(): void {
  process.exitCode = 1;
  setTimeout(() => process.exit(1), FATAL_EXIT_DELAY_MS);
}

export function installTerminalProcessGuards(): void {
  installCrashLogging('terminal-server');

  process.on('uncaughtException', (err) => {
    if (isNodePtyCleanupFailure(err)) {
      console.warn(
        '[lattice-terminal] swallowed node-pty error (pty cleanup):',
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.error('[lattice-terminal] uncaughtException', err);
    writeCrashLog('uncaughtException', err);
    crashAfterStderrFlush();
  });

  process.on('unhandledRejection', (reason) => {
    if (isNodePtyCleanupFailure(reason)) {
      console.warn(
        '[lattice-terminal] swallowed node-pty rejection:',
        reason instanceof Error ? reason.message : reason,
      );
      return;
    }
    console.error('[lattice-terminal] unhandledRejection', reason);
    writeCrashLog('unhandledRejection', reason);
    crashAfterStderrFlush();
  });
}
