// Same node-pty Windows cleanup guard as the main server. Must be registered
// before any PTY session can throw asynchronously.
export function installTerminalProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    if (stack.includes('node-pty')) {
      console.warn(
        '[lattice-terminal] swallowed node-pty error (pty cleanup):',
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.error('[lattice-terminal] uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    const stack =
      reason instanceof Error && reason.stack ? reason.stack : String(reason);
    if (stack.includes('node-pty')) {
      console.warn(
        '[lattice-terminal] swallowed node-pty rejection:',
        reason instanceof Error ? reason.message : reason,
      );
      return;
    }
    console.error('[lattice-terminal] unhandledRejection', reason);
  });
}
