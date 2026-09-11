import type * as pty from 'node-pty';
import { buildLatticeBanner } from '../terminalBanner.js';
import { TERMINAL_CONFIG } from '../terminalConfig.js';
import { deleteSession } from './sessionStore.js';
import type { Session } from './sessionTypes.js';
import { broadcastToSubscribers } from './broadcast.js';

export function wireSessionPtyEvents(session: Session): void {
  session.pty.onData((data) => {
    // Keep raw-byte liveness separate from printable-output activity. Codex
    // emits control-only synchronized redraws continuously even while idle.
    session.lastOutputAt = Date.now();
    session.outputFacts.write(data, session.lastOutputAt);
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
  // A single dim line telling the USER where this project's API reference is.
  // It goes into the scrollback, which only the browser ever replays — the pty
  // child (and therefore any harness running in it) never sees these bytes, so
  // this is not how agents discover the doc. That job belongs to the
  // system-prompt preamble the backend injects at spawn
  // (harnessSystemPrompts/latticePreamble.ts). Only emitted for
  // Lattice-managed projects (those that already have a .lattice/ directory,
  // hence a docPath).
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
