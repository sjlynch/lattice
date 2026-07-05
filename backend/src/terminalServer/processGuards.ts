// Same node-pty Windows cleanup guard as the main server. Must be registered
// before any PTY session can throw asynchronously.
//
// Swallow ONLY the known-cosmetic node-pty cleanup throw (see the main
// server's processGuards.ts for the full description). Every other uncaught
// exception / unhandled rejection is a real bug: installing these handlers
// disables Node's default fail-fast crash, so we log and then exit non-zero
// rather than leave this detached terminal-server running in an undefined
// state. The main backend respawns it on demand.

const FATAL_EXIT_DELAY_MS = 10;

function isNodePtyCleanupFailure(errOrReason: unknown): boolean {
  const stack =
    errOrReason instanceof Error && errOrReason.stack
      ? errOrReason.stack
      : String(errOrReason);
  return stack.includes('node-pty');
}

// Set the exit code immediately, then force-exit on a later tick so the
// just-written stderr has a moment to flush before we go down.
function crashAfterStderrFlush(): void {
  process.exitCode = 1;
  setTimeout(() => process.exit(1), FATAL_EXIT_DELAY_MS);
}

export function installTerminalProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    if (isNodePtyCleanupFailure(err)) {
      console.warn(
        '[lattice-terminal] swallowed node-pty error (pty cleanup):',
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.error('[lattice-terminal] uncaughtException', err);
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
    crashAfterStderrFlush();
  });
}
