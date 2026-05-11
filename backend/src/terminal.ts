import os from 'node:os';
import fs from 'node:fs';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { ensureLatticeApiDoc } from './latticeApiDocs.js';
import { ensureClaudeConfigValid } from './claudeConfigGuard.js';
import { createTerminalSessionId } from './ids.js';
import { killProcessTreeWindows } from './processTree.js';

const isWindows = os.platform() === 'win32';
const defaultShell = isWindows
  ? process.env.COMSPEC || 'powershell.exe'
  : process.env.SHELL || 'bash';

const BUFFER_REPLAY_MAX_BYTES = 200_000;
const INITIAL_COMMAND_WRITE_DELAY_MS = 250;
// Hard ceiling on simultaneously-live ptys. Real Lattice usage tops out
// around a dozen — anything above that is a runaway loop (e.g. a stuck
// reconnect on the frontend). MAX_TERMINAL_SESSIONS is generous enough
// to not bite legit power users while catching a runaway long before it
// can spawn enough conhost/pwsh processes to exhaust memory on Windows.
const MAX_TERMINAL_SESSIONS = 50;

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

function appendBuffer(session: Session, data: string) {
  session.buffer.push(data);
  session.bufferSize += data.length;
  while (
    session.bufferSize > BUFFER_REPLAY_MAX_BYTES &&
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

type SessionLaunchContext = {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  projectPath: string;
  env: { [key: string]: string };
  docPath: string | null;
};

function buildSessionLaunchContext(
  opts: CreateOpts,
): SessionLaunchContext | { error: string } {
  const shell = opts.shell || defaultShell;
  const requestedCwd = opts.cwd?.trim();
  const cwd = requestedCwd || os.homedir();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const projectPath = opts.projectPath?.trim() || cwd;

  const cwdError = validateRequestedCwd(requestedCwd);
  if (cwdError) return cwdError;

  // Plant breadcrumbs so AI agents running inside this pty can discover the
  // Lattice API without any user-side config. The vars only exist in this
  // child process; the user's shell env is untouched.
  const apiPort = Number(process.env.LATTICE_API_PORT) || 5184;
  const latticeEnv: Record<string, string> = {
    LATTICE_API_URL: `http://127.0.0.1:${apiPort}`,
    LATTICE_PROJECT: projectPath,
  };
  const docPath = ensureLatticeApiDoc(projectPath, apiPort);
  if (docPath) latticeEnv.LATTICE_DOCS = docPath;

  return {
    shell,
    cwd,
    cols,
    rows,
    projectPath,
    env: { ...(process.env as { [key: string]: string }), ...latticeEnv },
    docPath,
  };
}

function validateRequestedCwd(cwd: string | undefined): { error: string } | null {
  // Refuse to spawn into a non-existent cwd. Without this, pty.spawn
  // succeeds on Windows but the shell exits immediately — and if a
  // client is reconnecting in a loop (e.g. after a worktree was
  // deleted), every cycle spawns a doomed shell. The exit closes the
  // WS, the client reconnects, repeat forever. A simple existence
  // check turns that infinite loop into a one-shot error.
  if (!cwd) return null;
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return { error: `cwd is not a directory: ${cwd}` };
    }
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }
  return null;
}

function addLatticeBanner(session: Session, docPath: string | null): void {
  // Skill-style hint: a single dim line that names the trigger keywords and
  // points at the on-disk docs. Keeps the always-on context cost to one
  // sentence; the body of the API reference is loaded on demand if (and
  // only if) the AI agent follows the hint and reads $LATTICE_DOCS.
  // Only emitted for Lattice-managed projects (those that already have a
  // .lattice/ directory, hence a docPath).
  if (!docPath) return;
  const banner = buildLatticeBanner();
  session.buffer.push(banner);
  session.bufferSize += banner.length;
}

function scheduleInitialCommand(term: pty.IPty, initialCommand?: string): void {
  if (!initialCommand) return;
  setTimeout(() => {
    try {
      term.write(initialCommand + '\r');
    } catch {
      /* ignore */
    }
  }, INITIAL_COMMAND_WRITE_DELAY_MS);
}

function createSession(opts: CreateOpts): Session | { error: string } {
  // Hard cap so a runaway client (e.g. a stuck reconnect loop) can't
  // spawn unbounded ptys. Each pty on Windows is ~3 OS processes
  // (conhost + pwsh + node child); without this cap a runaway took the
  // whole machine out of memory before any human noticed.
  if (sessions.size >= MAX_TERMINAL_SESSIONS) {
    console.warn(
      `[terminal] refusing createSession: ${sessions.size} live sessions (cap ${MAX_TERMINAL_SESSIONS}). Likely a runaway client.`,
    );
    return {
      error: `Too many active terminal sessions (${sessions.size}/${MAX_TERMINAL_SESSIONS}). Close some terminals before opening another.`,
    };
  }

  const context = buildSessionLaunchContext(opts);
  if ('error' in context) return context;

  let term: pty.IPty;
  try {
    term = pty.spawn(context.shell, [], {
      name: 'xterm-256color',
      cols: context.cols,
      rows: context.rows,
      cwd: context.cwd,
      env: context.env,
    });
  } catch (err) {
    return {
      error: `Failed to spawn shell ${context.shell}: ${(err as Error).message}`,
    };
  }

  const session: Session = {
    id: createTerminalSessionId(),
    pty: term,
    buffer: [],
    bufferSize: 0,
    cols: context.cols,
    rows: context.rows,
    cwd: context.cwd,
    shell: context.shell,
    projectPath: context.projectPath,
    subscribers: new Set(),
    createdAt: Date.now(),
    killing: false,
  };
  sessions.set(session.id, session);
  console.log(
    `[terminal] created ${session.id} (cwd=${session.cwd}, shell=${session.shell}, pid=${term.pid})`,
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

  addLatticeBanner(session, context.docPath);
  scheduleInitialCommand(term, opts.initialCommand);

  return session;
}

function buildLatticeBanner(): string {
  // Dim cyan so the banner reads as ambient terminal chrome rather than
  // user-relevant output. \r\n because the pty is in raw mode; a bare \n
  // would not return the cursor to column 0.
  const dim = '\x1b[2;36m';
  const reset = '\x1b[0m';
  return (
    '\r\n' +
    `${dim}[Lattice] AI agents: when the user mentions Lattice / tasks / taskboard / merging / worktrees, read $LATTICE_DOCS for the API reference.${reset}` +
    '\r\n'
  );
}

// Pre-create a session WITHOUT a WS subscriber. Used by route handlers that
// want to spawn a pty and return its serverId in the same response, so the
// frontend can lazy-mount the <TerminalPane> instead of having to mount it
// immediately just to trigger session creation via WS attach. The pty starts
// running (initialCommand fires) regardless of whether anyone connects; the
// BUFFER_REPLAY_MAX_BYTES rolling buffer captures output for replay when a
// subscriber later attaches via `attachTerminal({ id })`.
export function precreateSession(
  opts: CreateOpts,
): { id: string } | { error: string } {
  const result = createSession(opts);
  if ('error' in result) return { error: result.error };
  return { id: result.id };
}

export type AttachOpts = {
  id?: string | null;
  cwd?: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  projectPath?: string;
};

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
  const session = sessions.get(opts.id) ?? null;
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
  const full = session.buffer.join('');
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
  const pid = session.pty.pid;
  console.log(
    `[terminal] killing session ${id} (cwd=${session.cwd}, pid=${pid}, subscribers=${session.subscribers.size})`,
  );
  try {
    session.pty.kill();
  } catch (err) {
    console.warn(`[terminal] pty.kill threw for ${id}:`, err);
  }
  // Belt-and-braces: pty.kill closes the conpty but doesn't reach
  // grandchildren (claude/node spawned by powershell). Force-kill the whole
  // process tree on Windows so they don't accumulate as orphans.
  killProcessTreeWindows(pid);
  // taskkill /F gives Claude no chance to flush ~/.claude.json. After it's
  // landed, validate the file and restore from backup if the kill
  // truncated a write. Without refreshBackup — the file may still be in
  // a pending-flush state we don't want to capture as "known good".
  setTimeout(() => {
    void ensureClaudeConfigValid();
  }, 2000);
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
