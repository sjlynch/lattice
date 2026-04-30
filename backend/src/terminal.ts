import os from 'node:os';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

const isWindows = os.platform() === 'win32';
const defaultShell = isWindows
  ? process.env.COMSPEC || 'powershell.exe'
  : process.env.SHELL || 'bash';

const MAX_BUFFER_BYTES = 200_000;
const INITIAL_COMMAND_DELAY_MS = 250;

type Session = {
  id: string;
  pty: pty.IPty;
  buffer: string[];
  bufferSize: number;
  cols: number;
  rows: number;
  cwd: string;
  shell: string;
  subscribers: Set<WebSocket>;
  createdAt: number;
};

const sessions = new Map<string, Session>();

function newId(): string {
  return `tty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendBuffer(session: Session, data: string) {
  session.buffer.push(data);
  session.bufferSize += data.length;
  while (
    session.bufferSize > MAX_BUFFER_BYTES &&
    session.buffer.length > 1
  ) {
    const removed = session.buffer.shift();
    if (removed) session.bufferSize -= removed.length;
  }
}

function broadcast(session: Session, payload: string) {
  for (const ws of session.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

type CreateOpts = {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
};

function createSession(opts: CreateOpts): Session | { error: string } {
  const shell = opts.shell || defaultShell;
  const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : os.homedir();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  let term: pty.IPty;
  try {
    term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env as { [key: string]: string },
    });
  } catch (err) {
    return {
      error: `Failed to spawn shell ${shell}: ${(err as Error).message}`,
    };
  }

  const session: Session = {
    id: newId(),
    pty: term,
    buffer: [],
    bufferSize: 0,
    cols,
    rows,
    cwd,
    shell,
    subscribers: new Set(),
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);

  term.onData((data) => {
    appendBuffer(session, data);
    broadcast(session, JSON.stringify({ type: 'data', data }));
  });
  term.onExit(({ exitCode }) => {
    broadcast(session, JSON.stringify({ type: 'exit', exitCode }));
    for (const ws of session.subscribers) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    sessions.delete(session.id);
  });

  if (opts.initialCommand) {
    setTimeout(() => {
      try {
        term.write(opts.initialCommand! + '\r');
      } catch {
        /* ignore */
      }
    }, INITIAL_COMMAND_DELAY_MS);
  }

  return session;
}

export type AttachOpts = {
  id?: string | null;
  cwd?: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
};

export function attachTerminal(ws: WebSocket, opts: AttachOpts) {
  let session: Session | null = null;
  if (opts.id) {
    session = sessions.get(opts.id) ?? null;
  }

  let replayed = false;
  if (!session) {
    const result = createSession(opts);
    if ('error' in result) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    session = result;
  } else {
    replayed = true;
    if (
      opts.cols &&
      opts.rows &&
      (opts.cols !== session.cols || opts.rows !== session.rows)
    ) {
      try {
        session.pty.resize(opts.cols, opts.rows);
        session.cols = opts.cols;
        session.rows = opts.rows;
      } catch {
        /* ignore */
      }
    }
  }

  session.subscribers.add(ws);

  try {
    ws.send(
      JSON.stringify({
        type: 'attached',
        id: session.id,
        cols: session.cols,
        rows: session.rows,
        replayed,
      }),
    );
  } catch {
    /* ignore */
  }

  if (replayed) {
    const full = session.buffer.join('');
    if (full.length > 0) {
      try {
        ws.send(JSON.stringify({ type: 'data', data: full }));
      } catch {
        /* ignore */
      }
    }
  }

  ws.on('message', (raw) => {
    if (!session) return;
    let msg: { type: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      try {
        session.pty.write(msg.data);
      } catch {
        /* ignore */
      }
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try {
        session.pty.resize(msg.cols, msg.rows);
        session.cols = msg.cols;
        session.rows = msg.rows;
      } catch {
        /* ignore */
      }
    } else if (msg.type === 'kill') {
      try {
        session.pty.kill();
      } catch {
        /* ignore */
      }
    }
  });

  ws.on('close', () => {
    if (session) session.subscribers.delete(ws);
    // Intentional: do NOT kill the pty when a client disconnects. The
    // session lives until /api/terminals/:id is DELETEd or the pty exits
    // on its own — that is what makes refresh-recovery work.
  });
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    session.pty.kill();
  } catch {
    /* ignore */
  }
  return true;
}

export function listSessions(): Array<{
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
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
    createdAt: s.createdAt,
    subscribers: s.subscribers.size,
    bufferSize: s.bufferSize,
  }));
}
