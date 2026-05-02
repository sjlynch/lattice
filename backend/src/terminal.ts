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
  // The Lattice project (active folder) this session belongs to. Used by
  // the frontend to scope terminals — when the user switches between
  // projects, only the active project's terminals are shown.
  projectPath: string;
  subscribers: Set<WebSocket>;
  createdAt: number;
  // Set the moment killSession runs the first time. Guards against
  // duplicate DELETE arrivals (StrictMode double-fire, double-click,
  // run-during-cleanup race) calling pty.kill() twice — node-pty's
  // Windows cleanup is fragile enough on the first call.
  killing: boolean;
};

const sessions = new Map<string, Session>();
let sessionCounter = 0;

function newId(): string {
  // Counter + timestamp so two sessions created in the same millisecond
  // can never collide. Math.random() suffix keeps the id short while
  // still being unguessable at a glance.
  sessionCounter += 1;
  return `tty_${Date.now()}_${sessionCounter}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
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
  // Project (active folder) this terminal belongs to. Falls back to cwd
  // if not supplied — sessions created before per-project scoping was
  // wired up still have a projectPath that's at least their working dir.
  projectPath?: string;
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
    projectPath: opts.projectPath?.trim() || cwd,
    subscribers: new Set(),
    createdAt: Date.now(),
    killing: false,
  };
  sessions.set(session.id, session);
  console.log(
    `[terminal] created ${session.id} (cwd=${cwd}, shell=${shell}, pid=${term.pid})`,
  );

  term.onData((data) => {
    appendBuffer(session, data);
    broadcast(session, JSON.stringify({ type: 'data', data }));
  });
  term.onExit(({ exitCode }) => {
    console.log(
      `[terminal] session ${session.id} exited (code=${exitCode}, cwd=${session.cwd}, subscribers=${session.subscribers.size})`,
    );
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
  projectPath?: string;
};

export function attachTerminal(ws: WebSocket, opts: AttachOpts) {
  let session: Session | null = null;
  // Track whether the client supplied a serverId but we couldn't find the
  // session (backend restarted and sessions are gone). In that case, create
  // a clean shell WITHOUT running initialCommand — the user doesn't want
  // a stale agent command re-executed just because the backend bounced.
  let staleReconnect = false;
  if (opts.id) {
    session = sessions.get(opts.id) ?? null;
    if (!session) staleReconnect = true;
  }

  let replayed = false;
  if (!session) {
    const result = createSession({
      ...opts,
      initialCommand: staleReconnect ? undefined : opts.initialCommand,
    });
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

// Kill all sessions whose cwd is `prefix` or starts with `prefix + sep`.
// Returns the count of sessions killed.
export function killSessionsByCwd(prefix: string): number {
  const norm = prefix.replace(/[\\/]+$/, '').toLowerCase();
  let count = 0;
  for (const [, session] of sessions) {
    const sessionNorm = session.cwd.replace(/[\\/]+$/, '').toLowerCase();
    if (sessionNorm === norm || sessionNorm.startsWith(norm + '/') || sessionNorm.startsWith(norm + '\\')) {
      killSession(session.id);
      count += 1;
    }
  }
  return count;
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) {
    console.warn(`[terminal] killSession: no session with id ${id}`);
    return false;
  }
  if (session.killing) {
    console.log(`[terminal] killSession: ${id} already killing, no-op`);
    return true;
  }
  session.killing = true;
  console.log(
    `[terminal] killing session ${id} (cwd=${session.cwd}, subscribers=${session.subscribers.size})`,
  );
  try {
    session.pty.kill();
  } catch (err) {
    console.warn(`[terminal] pty.kill threw for ${id}:`, err);
  }
  return true;
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
    bufferSize: s.bufferSize,
  }));
}
