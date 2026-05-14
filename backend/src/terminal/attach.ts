import type { WebSocket } from 'ws';
import type { AttachOpts, Session } from './sessionTypes.js';
import { getSession } from './sessionStore.js';
import { createSession } from './createSession.js';

type AttachResult = {
  session: Session;
  replayed: boolean;
};

function attachNewSession(ws: WebSocket, opts: AttachOpts): AttachResult | null {
  const result = createSession(opts);
  if ('error' in result) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: result.error }));
      ws.close();
    } catch {
      /* ignore */
    }
    return null;
  }
  return { session: result, replayed: false };
}

function attachExistingSession(
  ws: WebSocket,
  opts: AttachOpts & { id: string },
): AttachResult | null {
  const session = getSession(opts.id) ?? null;
  if (!session) {
    sendSessionLost(ws, opts.id);
    return null;
  }

  resizeSessionForAttach(session, opts);
  return { session, replayed: true };
}

function sendSessionLost(ws: WebSocket, id: string): void {
  // Stale id (terminal-server restarted, or session was killed via
  // worktree cleanup, or pty exited and was deleted). DO NOT silently
  // spawn a fresh pty here — the client's reconnect logic would treat
  // every WS close as "try again" and we'd produce a runaway:
  //   client.onclose → client.connect(id) → backend creates new pty
  //   → pty doomed (cwd may be gone, or user expects different state)
  //   → exit → client.onclose → repeat, forever, ~3 OS procs / cycle.
  // Sending session_lost lets the frontend mark the terminal as gone
  // and stop reconnecting. If the user wants a fresh shell they can
  // close the tab and open a new one — that's an explicit, bounded
  // action with no feedback loop.
  console.warn(`[terminal] attach with unknown id ${id} — session_lost`);
  try {
    ws.send(
      JSON.stringify({
        type: 'session_lost',
        message: 'Terminal session no longer exists. Close this tab and start a new one if you need a fresh shell.',
      }),
    );
    ws.close();
  } catch {
    /* ignore */
  }
}

function resizeSessionForAttach(session: Session, opts: AttachOpts): void {
  if (
    !opts.cols ||
    !opts.rows ||
    (opts.cols === session.cols && opts.rows === session.rows)
  ) {
    return;
  }

  try {
    session.pty.resize(opts.cols, opts.rows);
    session.cols = opts.cols;
    session.rows = opts.rows;
  } catch {
    /* ignore */
  }
}

export function attachTerminal(ws: WebSocket, opts: AttachOpts) {
  const attached = opts.id
    ? attachExistingSession(ws, { ...opts, id: opts.id })
    : attachNewSession(ws, opts);
  if (!attached) return;

  const { session, replayed } = attached;
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

  // Send any buffered output. Covers two cases:
  //   - replay on reconnect (existing session, scrollback the user had)
  //   - first attach to a pre-spawned session whose buffer already holds
  //     the Lattice banner (and any pty output that arrived before the
  //     subscriber connected).
  const full = session.buffer.replay();
  if (full.length > 0) {
    try {
      ws.send(JSON.stringify({ type: 'data', data: full }));
    } catch {
      /* ignore */
    }
  }

  ws.on('message', (raw) => {
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
    session.subscribers.delete(ws);
    // Intentional: do NOT kill the pty when a client disconnects. The
    // session lives until /api/terminals/:id is DELETEd or the pty exits
    // on its own — that is what makes refresh-recovery work.
  });
}
