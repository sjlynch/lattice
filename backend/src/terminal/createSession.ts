import os from 'node:os';
import * as pty from 'node-pty';
import { agentHarnessForCommand } from '../harnesses.js';
import { createTerminalSessionId } from '../ids.js';
import { ScrollbackStore } from './scrollbackStore.js';
import { TerminalOutputFacts } from './outputFacts.js';
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

// Run agent ptys below normal priority. Agents fan out into test runners,
// bundlers and type-checkers; a dozen of them on a large repo pinned every
// core and froze the desktop — the user's UI, the browser, and Lattice's own
// backend all competing at the same priority as the agents (2026-09-22). At
// below-normal they still get every idle cycle, but yield to interactive work.
// On Windows a child created by a BELOW_NORMAL process inherits BELOW_NORMAL,
// so lowering the pty's shell before the agent command is typed covers the
// whole tree the agent spawns later; on POSIX children inherit the nice value.
// Agent sessions only (a user's own shell / dev server keeps normal priority).
// Escape hatch: LATTICE_AGENT_PRIORITY=normal in the terminal-server's env.
export function lowerAgentPriority(pid: number, initialCommand: string | undefined): void {
  if (process.env.LATTICE_AGENT_PRIORITY === 'normal') return;
  if (!agentHarnessForCommand(initialCommand)) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (err) {
    console.warn(`[terminal] could not lower priority of agent pty ${pid}: ${(err as Error).message}`);
  }
}

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

  const id = createTerminalSessionId();
  const session: Session = {
    id,
    pty: term,
    scrollback: new ScrollbackStore(id),
    cols: context.cols,
    rows: context.rows,
    cwd: context.cwd,
    shell: context.shell,
    projectPath: context.projectPath,
    subscribers: new Set(),
    createdAt: Date.now(),
    // Seeded at spawn so a session that has not produced a byte yet still has a
    // usable clock (a never-written `lastOutputAt` would read as infinitely
    // idle). Record the RAW command, not `context.initialCommand` — the
    // per-harness rewriters bolt flags/`-c` overrides onto it, and all the
    // activity classifier wants is which binary this pty launched.
    lastOutputAt: Date.now(),
    outputFacts: new TerminalOutputFacts(),
    initialCommand: opts.initialCommand,
    killing: false,
  };
  addSession(session);
  console.log(
    `[terminal] created ${session.id} (cwd=${session.cwd}, shell=${session.shell}, pid=${term.pid})`,
  );

  wireSessionPtyEvents(session);
  addLatticeBanner(session, context.docPath);
  // Before the agent launches, so everything it spawns inherits the priority.
  lowerAgentPriority(term.pid, opts.initialCommand);
  scheduleInitialCommand(term, context.initialCommand);

  return session;
}

// Pre-create a session WITHOUT a WS subscriber. Used by route handlers that
// want to spawn a pty and return its serverId in the same response, so the
// frontend can lazy-mount the <TerminalPane> instead of having to mount it
// immediately just to trigger session creation via WS attach. The pty starts
// running (initialCommand fires) regardless of whether anyone connects; the
// disk-backed ScrollbackStore captures output for replay when a subscriber
// later attaches via `attachTerminal({ id })`.
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
