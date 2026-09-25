import type { WebSocket } from 'ws';
import type { AttachOpts, Session } from './sessionTypes.js';
import { getSession } from './sessionStore.js';
import { createSession } from './createSession.js';
import { killSession } from './kill.js';
import { holdSubscriber, releaseSubscriber } from './broadcast.js';

// A pty size is a positive integer; anything else (NaN, 0, a float, a huge
// negative from a mangled query) is ignored rather than handed to node-pty.
// Same predicate the backend's POST /api/terminals applies to its body. Capped
// at ConPTY's signed 16-bit COORD limit — a larger size misbehaves on Windows.
export const MAX_PTY_DIMENSION = 32767;
export function isPtyDimension(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_PTY_DIMENSION;
}

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
    !isPtyDimension(opts.cols) ||
    !isPtyDimension(opts.rows) ||
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
  // Subscribe FIRST, but hold this socket's live frames: the replay below is
  // read off the event loop, and output the pty emits meanwhile must reach the
  // client after the history it follows, never before it (and never twice —
  // the replay snapshot excludes it; see ScrollbackStore.replayAsync).
  session.subscribers.add(ws);
  holdSubscriber(ws);

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

  ws.on('message', (raw) => {
    let msg: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown } | null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // `null`, a number, a string or an array parses fine but is not a frame:
    // reading `.type` off `null` would throw outside the try, inside a ws
    // listener — an uncaughtException that takes down the detached
    // terminal-server and every live pty with it.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.type === 'input' && typeof msg.data === 'string') {
      try {
        session.pty.write(msg.data);
      } catch {
        /* ignore */
      }
    } else if (msg.type === 'resize' && isPtyDimension(msg.cols) && isPtyDimension(msg.rows)) {
      try {
        session.pty.resize(msg.cols, msg.rows);
        session.cols = msg.cols;
        session.rows = msg.rows;
      } catch {
        /* ignore */
      }
    } else if (msg.type === 'kill') {
      // The one kill path: `killing` guard, Windows process-tree kill, the
      // deferred ~/.claude.json check. A bare pty.kill() had none of them.
      killSession(session.id);
    }
  });

  // Without an 'error' listener, ws v8 re-throws an underlying socket error
  // (ECONNRESET/EPIPE from an abruptly-closed tab, network partition, or OS
  // sleep) as a process-level uncaughtException, which would take down the
  // detached terminal-server and every other live pty session with it. A
  // dropped client is routine — log-and-ignore (the 'close' handler below
  // still runs and drops the subscriber). Mirrors terminalWsRelay's proxy.
  ws.on('error', () => { /* routine client disconnect — ignore */ });

  ws.on('close', () => {
    session.subscribers.delete(ws);
    releaseSubscriber(ws);
    // Intentional: do NOT kill the pty when a client disconnects. The
    // session lives until /api/terminals/:id is DELETEd or the pty exits
    // on its own — that is what makes refresh-recovery work.
  });

  // Send the scrollback replay window. Covers two cases:
  //   - replay on reconnect (existing session, scrollback the user had)
  //   - first attach to a pre-spawned session whose log already holds
  //     the Lattice banner (and any pty output that arrived before the
  //     subscriber connected).
  // Read asynchronously: a synchronous up-to-2 MB read per attach, times the
  // N panes that re-attach after a backend restart, stalled the event loop
  // hosting every pty long enough to fail the executor's health probe.
  // A failed read degrades to "no replay": the subscriber must still be
  // released (or its live frames stay held forever), and an unhandled
  // rejection here would exit the executor along with every pty it hosts.
  const deliver = (full: string): void => {
    const queued = releaseSubscriber(ws);
    if (ws.readyState !== ws.OPEN) return;
    try {
      if (full.length > 0) ws.send(JSON.stringify({ type: 'data', data: full }));
      for (const frame of queued) ws.send(frame);
    } catch {
      /* ignore */
    }
  };
  void session.scrollback.replayAsync().then(deliver, () => deliver(''));
}
