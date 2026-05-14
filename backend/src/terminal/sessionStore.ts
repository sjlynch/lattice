import type { Session } from './sessionTypes.js';

const sessions = new Map<string, Session>();

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function addSession(session: Session): void {
  sessions.set(session.id, session);
}

export function deleteSession(id: string): void {
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
    bufferSize: s.buffer.size,
  }));
}
