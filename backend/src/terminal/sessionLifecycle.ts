import type * as pty from 'node-pty';
import { buildLatticeBanner } from '../terminalBanner.js';
import { TERMINAL_CONFIG } from '../terminalConfig.js';
import { deleteSession } from './sessionStore.js';
import type { Session } from './sessionTypes.js';
import { broadcastToSubscribers } from './broadcast.js';

export function wireSessionPtyEvents(session: Session): void {
  session.pty.onData((data) => {
    // Cheapest possible activity stamp. `listSessions` reports it and the main
    // backend turns output-recency into the sidebar's per-tab agent spinner
    // (see terminalActivity.ts) — nothing here interprets it.
    session.lastOutputAt = Date.now();
    session.scrollback.append(data);
    broadcastToSubscribers(session.subscribers, JSON.stringify({ type: 'data', data }));
  });
  session.pty.onExit(({ exitCode }) => {
    console.log(
      `[terminal] session ${session.id} exited (code=${exitCode}, cwd=${session.cwd}, subscribers=${session.subscribers.size})`,
    );
    broadcastToSubscribers(session.subscribers, JSON.stringify({ type: 'exit', exitCode }));
    for (const ws of session.subscribers) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    deleteSession(session.id);
  });
}

export function addLatticeBanner(session: Session, docPath: string | null): void {
  // Skill-style hint: a single dim line that names the trigger keywords and
  // points at the on-disk docs. Keeps the always-on context cost to one
  // sentence; the body of the API reference is loaded on demand if (and
  // only if) the AI agent follows the hint and reads $LATTICE_DOCS.
  // Only emitted for Lattice-managed projects (those that already have a
  // .lattice/ directory, hence a docPath). The banner points at the doc by
  // its literal path so the hint survives cmd.exe (where `$LATTICE_DOCS`
  // wouldn't expand).
  if (!docPath) return;
  session.scrollback.append(buildLatticeBanner(docPath));
}

export function scheduleInitialCommand(term: pty.IPty, initialCommand?: string): void {
  if (!initialCommand) return;
  setTimeout(() => {
    try {
      term.write(initialCommand + '\r');
    } catch {
      /* ignore */
    }
  }, TERMINAL_CONFIG.INITIAL_COMMAND_WRITE_DELAY_MS);
}
