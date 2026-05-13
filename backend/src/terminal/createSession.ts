import os from 'node:os';
import fs from 'node:fs';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import { createTerminalSessionId } from '../ids.js';
import { buildLatticeBanner } from '../terminalBanner.js';
import { SessionBuffer } from '../terminalBuffer.js';
import { TERMINAL_CONFIG } from '../terminalConfig.js';
import type { CreateOpts, Session } from './sessionTypes.js';
import { addSession, deleteSession, sessionCount } from './sessionStore.js';

const isWindows = os.platform() === 'win32';
const defaultShell = isWindows
  ? process.env.COMSPEC || 'powershell.exe'
  : process.env.SHELL || 'bash';

export function broadcastToSubscribers(subscribers: Set<WebSocket>, data: string): void {
  for (const ws of subscribers) {
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
  }
}

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
  session.buffer.append(buildLatticeBanner());
}

function scheduleInitialCommand(term: pty.IPty, initialCommand?: string): void {
  if (!initialCommand) return;
  setTimeout(() => {
    try {
      term.write(initialCommand + '\r');
    } catch {
      /* ignore */
    }
  }, TERMINAL_CONFIG.INITIAL_COMMAND_WRITE_DELAY_MS);
}

export function createSession(opts: CreateOpts): Session | { error: string } {
  // Hard cap so a runaway client (e.g. a stuck reconnect loop) can't
  // spawn unbounded ptys. Each pty on Windows is ~3 OS processes
  // (conhost + pwsh + node child); without this cap a runaway took the
  // whole machine out of memory before any human noticed.
  const live = sessionCount();
  if (live >= TERMINAL_CONFIG.MAX_TERMINAL_SESSIONS) {
    console.warn(
      `[terminal] refusing createSession: ${live} live sessions (cap ${TERMINAL_CONFIG.MAX_TERMINAL_SESSIONS}). Likely a runaway client.`,
    );
    return {
      error: `Too many active terminal sessions (${live}/${TERMINAL_CONFIG.MAX_TERMINAL_SESSIONS}). Close some terminals before opening another.`,
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
    buffer: new SessionBuffer(),
    cols: context.cols,
    rows: context.rows,
    cwd: context.cwd,
    shell: context.shell,
    projectPath: context.projectPath,
    subscribers: new Set(),
    createdAt: Date.now(),
    killing: false,
  };
  addSession(session);
  console.log(
    `[terminal] created ${session.id} (cwd=${session.cwd}, shell=${session.shell}, pid=${term.pid})`,
  );

  term.onData((data) => {
    session.buffer.append(data);
    broadcastToSubscribers(session.subscribers, JSON.stringify({ type: 'data', data }));
  });
  term.onExit(({ exitCode }) => {
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

  addLatticeBanner(session, context.docPath);
  scheduleInitialCommand(term, opts.initialCommand);

  return session;
}

// Pre-create a session WITHOUT a WS subscriber. Used by route handlers that
// want to spawn a pty and return its serverId in the same response, so the
// frontend can lazy-mount the <TerminalPane> instead of having to mount it
// immediately just to trigger session creation via WS attach. The pty starts
// running (initialCommand fires) regardless of whether anyone connects; the
// TERMINAL_CONFIG.BUFFER_REPLAY_MAX_BYTES rolling buffer captures output for replay when a
// subscriber later attaches via `attachTerminal({ id })`.
export function precreateSession(
  opts: CreateOpts,
): { id: string } | { error: string } {
  const result = createSession(opts);
  if ('error' in result) return { error: result.error };
  return { id: result.id };
}
