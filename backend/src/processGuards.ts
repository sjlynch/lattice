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
// failed cleanup is purely cosmetic. Swallow only node-pty errors here so
// real bugs still surface.

export function installProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    if (stack.includes('node-pty')) {
      console.warn(
        '[lattice] swallowed node-pty error (pty cleanup, not fatal):',
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.error('[lattice] uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    const stack =
      reason instanceof Error && reason.stack ? reason.stack : String(reason);
    if (stack.includes('node-pty')) {
      console.warn(
        '[lattice] swallowed node-pty rejection:',
        reason instanceof Error ? reason.message : reason,
      );
      return;
    }
    console.error('[lattice] unhandledRejection', reason);
  });
}
