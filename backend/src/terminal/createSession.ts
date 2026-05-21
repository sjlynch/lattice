import * as pty from 'node-pty';
import { createTerminalSessionId } from '../ids.js';
import { SessionBuffer } from '../terminalBuffer.js';
import { TERMINAL_CONFIG } from '../terminalConfig.js';
import type { CreateOpts, Session } from './sessionTypes.js';
import { addSession, sessionCount } from './sessionStore.js';
import { buildSessionLaunchContext } from './launchContext.js';
import {
  addLatticeBanner,
  scheduleInitialCommand,
  wireSessionPtyEvents,
} from './sessionLifecycle.js';

export { broadcastToSubscribers } from './broadcast.js';

// 'CAP' tags a refusal caused by the hard session ceiling specifically (as
// opposed to a shell-spawn failure). The spawn queue keys its over-admit
// back-off on this code, so it must round-trip backend ⇆ terminal-server.
export type SessionErrorResult = { error: string; code?: 'CAP' };

export function createSession(
  opts: CreateOpts,
): Session | SessionErrorResult {
  // Hard cap so a runaway client (e.g. a stuck reconnect loop) can't
  // spawn unbounded ptys. Each pty on Windows is ~3 OS processes
  // (conhost + pwsh + node child); without this cap a runaway took the
  // whole machine out of memory before any human noticed. The spawn queue
  // governs normal concurrency well below this — a CAP refusal here means
  // either a runaway or a transient queue-accounting drift it self-corrects.
  const live = sessionCount();
  if (live >= TERMINAL_CONFIG.MAX_TERMINAL_SESSIONS) {
    console.warn(
      `[terminal] refusing createSession: ${live} live sessions (cap ${TERMINAL_CONFIG.MAX_TERMINAL_SESSIONS}). Likely a runaway client.`,
    );
    return {
      error: `Too many active terminal sessions (${live}/${TERMINAL_CONFIG.MAX_TERMINAL_SESSIONS}). Close some terminals before opening another.`,
      code: 'CAP',
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
      // Use node-pty's bundled conpty.dll instead of the system one. The
      // system path's `pty.kill()` does a `child_process.fork()` of
      // `conpty_console_list_agent.js` (node-pty's
      // lib/windowsPtyAgent.js:184) to enumerate the conpty's process
      // list — that fork spawns a fresh node.exe without `windowsHide`,
      // briefly flashing a console window every time a terminal closes.
      // The DLL path skips the fork entirely (windowsPtyAgent.js:153
      // branch); enumeration happens in-process. `taskkill` (without
      // `detached: true`) still runs afterwards to reap grandchildren
      // (Claude under pwsh), but with windowsHide it doesn't flash.
      useConptyDll: true,
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

  wireSessionPtyEvents(session);
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
): { id: string } | SessionErrorResult {
  const result = createSession(opts);
  if ('error' in result) {
    return result.code
      ? { error: result.error, code: result.code }
      : { error: result.error };
  }
  return { id: result.id };
}
