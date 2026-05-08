import os from 'node:os';
import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { ensureLatticeApiDoc } from './latticeApiDocs.js';
import { ensureClaudeConfigValid } from './claudeConfigGuard.js';

const isWindows = os.platform() === 'win32';

// Windows has no process groups, so `pty.kill()` (which closes the conpty
// and signals the spawned shell) leaves the shell's children — and their
// children — running. Powershell exits, but `claude` (a node child) keeps
// going, and after a few run/qa cycles you have dozens of orphan Claude
// processes munching CPU/RAM.
//
// `taskkill /F /T /PID <pid>` walks and force-kills the whole tree. We
// fire it AFTER pty.kill so the conpty handle is already torn down, then
// detach so we don't block the caller waiting for taskkill to finish.
function killProcessTreeWindows(pid: number): void {
  if (!isWindows || !pid) return;
  try {
    const child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    // Detach so we don't keep a handle; swallow the inevitable ENOENT/
    // exit-1 (PID already gone) without polluting the log.
    child.on('error', () => { /* ignore */ });
    child.unref();
  } catch {
    /* spawn itself failed — process may already be gone */
  }
}
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
  const projectPath = opts.projectPath?.trim() || cwd;

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

  let term: pty.IPty;
  try {
    term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...(process.env as { [key: string]: string }), ...latticeEnv },
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
    projectPath,
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

  // Skill-style hint: a single dim line that names the trigger keywords and
  // points at the on-disk docs. Keeps the always-on context cost to one
  // sentence; the body of the API reference is loaded on demand if (and
  // only if) the AI agent follows the hint and reads $LATTICE_DOCS.
  // Only emitted for Lattice-managed projects (those that already have a
  // .lattice/ directory, hence a docPath).
  if (docPath) {
    const banner = buildLatticeBanner();
    session.buffer.push(banner);
    session.bufferSize += banner.length;
  }

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
// 200 KB rolling buffer captures output for replay when a subscriber later
// attaches via `attachTerminal({ id })`.
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
