import type { Session } from './sessionTypes.js';

const sessions = new Map<string, Session>();

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
    initialCommand: s.initialCommand,
  }));
}
