import type { Terminal } from '@xterm/xterm';
import type { TerminalStatus } from '../../terminal/terminalTypes';
import { buildTerminalWsQuery, type TerminalWsQueryArgs } from './connectionParams';
import type { createTerminalOutput } from './terminalOutput';

// Preserve the connection helpers' existing import path for input forwarding.
export { forwardTerminalInput, RESIZE_DEBOUNCE_MS } from './terminalInput';

// Mechanism behind `useTerminalConnection` — the `/ws/terminal` protocol with
// no React in it: URL building, message decoding, reconnect/backoff maths, and
// user-visible terminal-body notices. Input/resize ownership lives in
// `terminalInput.ts`; the reconnect lifecycle *state machine*
// (terminated / attachedOnce / attempt)
// lives in `terminalReconnectController.ts`; the hook wires these focused
// helpers to React refs, xterm, and the WebSocket instance.

// Reconnect cap for a SERVERLESS terminal that has never attached: without a
// session id to re-subscribe to, each fresh connect can spawn a brand-new pty,
// so unbounded retries there could leak orphan ptys if the connect flaps. A
// terminal we CAN re-attach to (it has a serverId, or captured one via a prior
// `attached`) is not capped — see `shouldGiveUpReconnect` / the onclose handler.
export const MAX_RECONNECT_ATTEMPTS = 6;
// Backoff ceiling. Delays grow 250ms → 500 → … and then hold here, so a long
// outage keeps being retried roughly every 10s rather than giving up.
const RECONNECT_MAX_DELAY_MS = 10_000;
// How long a connection must stay open before it counts as HEALTHY and the
// backoff is allowed to reset. Mirrors api/ws.ts's WS_STABLE_MS. Resetting
// `attempt` the instant `onopen` fires lets a backend that completes the WS
// upgrade then immediately closes (a half-booted backend behind a proxy) pin the
// counter at 0: the backoff never grows past the 250ms floor, the give-up cap is
// never reached, and the client hammers /ws/terminal every ~250ms — re-running
// initialCommand and spawning a fresh pty each loop for a serverless terminal.
// Resetting only AFTER the socket survives this window makes a flapping backend
// back off (250ms→…→10s) while a serverless terminal still honours the cap.
// Exported so the regression test can distinguish the stability timer from a
// reconnect timer by its delay.
export const RECONNECT_STABLE_MS = 3000;

export type TerminalMessage = {
  type?: string;
  data?: string;
  id?: string;
  replayed?: boolean;
  message?: string;
  exitCode?: number;
};

// --- URL building -----------------------------------------------------------

export function buildTerminalWsUrl(args: TerminalWsQueryArgs): string {
  // The serverId↔initialCommand split (re-attach by id vs. fresh spawn) lives in
  // the pure, window-free `buildTerminalWsQuery` so it stays unit-testable in the
  // DOM-less node:test harness; this thin wrapper only adds the window-derived
  // ws://host prefix.
  const query = buildTerminalWsQuery(args);
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/terminal?${query}`;
}

// --- User-visible terminal-body notices ------------------------------------

// Every status line Lattice writes into the terminal body (as opposed to raw
// pty output). Centralised so the exact wording/styling is easy to audit.
export const terminalNotices = {
  reconnected(term: Terminal) {
    term.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n');
  },
  reconnecting(term: Terminal) {
    term.write('\r\n\x1b[2m[connection lost — reconnecting…]\x1b[0m\r\n');
  },
  gaveUp(term: Terminal) {
    term.write(
      '\r\n\x1b[31m[connection lost — gave up after ' +
        MAX_RECONNECT_ATTEMPTS +
        ' reconnect attempts. Close this tab and start a new terminal if needed.]\x1b[0m\r\n',
    );
  },
  error(term: Terminal, message: string | undefined) {
    term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
  },
  exited(term: Terminal, exitCode: number | undefined) {
    term.write(`\r\n\x1b[2m[exited ${exitCode}]\x1b[0m\r\n`);
  },
  sessionLost(term: Terminal, message: string | undefined) {
    term.write(`\r\n\x1b[2m[${message ?? 'session lost'}]\x1b[0m\r\n`);
  },
  outputDropped(term: Terminal) {
    term.write('\r\n\x1b[2m[output fell too far behind — skipped the backlog]\x1b[0m\r\n');
  },
};

// --- WebSocket message handling --------------------------------------------

export type TerminalMessageHandlers = {
  term: Terminal;
  output?: ReturnType<typeof createTerminalOutput>;
  // The serverId we connected with, so an `attached` frame only notifies the
  // parent when the backend hands back a *different* id.
  serverId?: string;
  // An `attached` frame arrived — the terminal-server now owns a live pty this
  // connection (and future reconnects) re-subscribe to.
  onAttached: () => void;
  // The backend handed back a session id different from the one we connected
  // with (or we connected serverless).
  onServerId: (id: string) => void;
  // The pty is gone for good (clean exit, or backend says the session is lost).
  // The hook flips its `terminated` flag here so the WS close that follows
  // doesn't trigger a reconnect.
  onTerminated: (status: TerminalStatus, exitCode?: number) => void;
};

export function handleTerminalMessage(
  raw: string,
  h: TerminalMessageHandlers,
): void {
  try {
    const msg = JSON.parse(raw) as TerminalMessage;
    if (msg.type === 'data' && typeof msg.data === 'string') {
      if (h.output) h.output.write(msg.data, msg.replayed);
      else h.term.write(msg.data);
    } else if (msg.type === 'attached') {
      h.onAttached();
      if (msg.id && msg.id !== h.serverId) {
        h.onServerId(msg.id);
      }
      // Whatever the pane shows now is stale: the frame that follows is the
      // scrollback replay (or nothing at all, for a brand-new session). A
      // reconnect used to APPEND the ~2 MB replay underneath the content the
      // pane already had — the same transcript twice, and for an inline TUI
      // (Codex, Claude) a minutes-long repaint on a busy machine. Clear the
      // buffer so the replay repaints exactly once. `clear()`, deliberately
      // not `reset()`: a full reset (RIS) also drops the DEC private modes the
      // running TUI switched on at startup — bracketed paste, mouse tracking,
      // the alternate screen — and those sequences sit far outside the replay
      // window of a long session, so nothing would switch them back on until
      // the TUI restarted (multi-line pastes would submit line by line).
      // With an output queue the clear is queued instead: it drops the stale
      // backlog and runs after the chunk xterm is still parsing.
      if (h.output) h.output.beginReplay();
      else h.term.clear();
    } else if (msg.type === 'error') {
      terminalNotices.error(h.term, msg.message);
    } else if (msg.type === 'exit') {
      terminalNotices.exited(h.term, msg.exitCode);
      // The pty is gone for good. The hook marks `terminated` so the WS close
      // that follows doesn't trigger a reconnect (which on a cleaned-up
      // worktree would create a doomed-to-exit pty, feeding back into another
      // close → another reconnect → runaway).
      h.onTerminated('exited', msg.exitCode);
    } else if (msg.type === 'session_lost') {
      terminalNotices.sessionLost(h.term, msg.message);
      h.onTerminated('dead');
    }
  } catch {
    /* ignore */
  }
}

// --- Reconnect / backoff decisions -----------------------------------------

// A terminal we can re-attach to (has a serverId, or captured one via an
// earlier `attached` frame this session) reconnects to its EXISTING pty —
// idempotent and safe to retry forever. A serverless terminal that never
// attached can spawn a fresh pty on reconnect, so it stays bounded.
export function canReattachTerminal(
  serverId: string | undefined,
  attachedOnce: boolean,
): boolean {
  return Boolean(serverId) || attachedOnce;
}

// Only a serverless, never-attached terminal gives up — and only once it has
// exhausted the attempt cap. The genuine stop for a re-attachable terminal is
// the hook's `terminated` flag (set on a clean `exit` / `session_lost`), not an
// attempt count.
export function shouldGiveUpReconnect(
  canReattach: boolean,
  attempt: number,
): boolean {
  return !canReattach && attempt >= MAX_RECONNECT_ATTEMPTS;
}

// Capped exponential backoff: 250ms → 500 → … topping out at the ceiling. The
// exponent is clamped so the delay holds at the ceiling instead of overflowing
// once `attempt` grows large during a long outage.
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_DELAY_MS, 250 * 2 ** Math.min(attempt, 6));
}
