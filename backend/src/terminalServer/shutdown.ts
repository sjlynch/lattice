import { killSession, listSessions } from '../terminal.js';

export type TerminalShutdown = () => Promise<void>;

export function createTerminalShutdown(): TerminalShutdown {
  // Clean up PTY sessions before exiting so node-pty child processes don't
  // linger as orphans (especially important on Windows where conpty helpers
  // can outlive their parent if not explicitly killed).
  //
  // killSession fires off `taskkill /F /T` asynchronously for grandchildren
  // — we have to give it a beat to actually land before process.exit, or
  // the spawned taskkill commands get killed along with us and the original
  // orphan problem returns.
  let shuttingDown = false;
  return async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const ids = listSessions().map((s) => s.id);
    console.log(`[lattice-terminal] shutdown: killing ${ids.length} session(s)`);
    for (const id of ids) {
      killSession(id);
    }
    // 500 ms is long enough for taskkill /T to walk a small process tree on
    // a modern Windows box; short enough that Ctrl+C still feels snappy.
    await new Promise<void>((r) => setTimeout(r, 500));
    process.exit(0);
  };
}

export function wireTerminalShutdownSignals(shutdown: TerminalShutdown): void {
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}
