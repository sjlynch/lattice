import { registerMemGauge } from '../memDiag/gauges.js';
import type { Session } from './sessionTypes.js';

const sessions = new Map<string, Session>();

function sumSessions(read: (s: Session) => number): number {
  let n = 0;
  for (const s of sessions.values()) n += read(s);
  return n;
}
registerMemGauge('terminal.sessions', () => sessions.size);
registerMemGauge('terminal.subscribers', () => sumSessions((s) => s.subscribers.size));
registerMemGauge('terminal.mem.scrollback', () => sumSessions((s) => s.scrollback.size));
// A kill whose pty never reported exit (should stay ~0).
registerMemGauge('terminal.stuckKills', () => sumSessions((s) => (s.killing ? 1 : 0)));

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function addSession(session: Session): void {
  sessions.set(session.id, session);
}

export function deleteSession(id: string): void {
  // Release the on-disk scrollback log at the single deletion point (covers
  // both natural pty exit and killSession → pty exit). Idempotent.
  const session = sessions.get(id);
  if (session) {
    try {
      session.scrollback.dispose();
    } catch {
      /* ignore */
    }
  }
  sessions.delete(id);
}

export function sessionCount(): number {
  return sessions.size;
}

export function allSessions(): Iterable<Session> {
  return sessions.values();
}

export function listSessions(): Array<{
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  projectPath: string;
  createdAt: number;
  subscribers: number;
  bufferSize: number;
  lastOutputAt: number;
  lastTextOutputAt: number;
  terminalTitle: string | null;
  initialCommand?: string;
}> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    cwd: s.cwd,
    shell: s.shell,
    cols: s.cols,
    rows: s.rows,
    projectPath: s.projectPath,
    createdAt: s.createdAt,
    subscribers: s.subscribers.size,
    bufferSize: s.scrollback.size,
    // Raw inputs for the main backend's terminal-activity signal (the sidebar
    // tab spinner). See sessionTypes.ts — this side records, it never judges.
    lastOutputAt: s.lastOutputAt,
    lastTextOutputAt: s.outputFacts.lastTextOutputAt,
    terminalTitle: s.outputFacts.terminalTitle,
    initialCommand: s.initialCommand,
  }));
}
