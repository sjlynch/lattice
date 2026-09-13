import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { TERMINAL_PORT } from './terminalServerLifecycle.js';
import { noteTerminalClientInput } from './terminalActivity.js';
import { createTerminalActivityRelayObserver } from './terminalActivityRelay.js';
import { withCodexActivityTitle } from './codexTerminalActivity.js';

// If the detached terminal-server doesn't accept the upstream connection within
// this window, stop waiting. Leaving the browser holding an open-but-silent
// socket looks like a frozen terminal that only a page refresh clears; closing
// the client side instead lets its reconnect logic retry once the terminal-
// server catches up (it owns the pty and survives this). The realistic trigger
// is the terminal-server being momentarily saturated under a heavy "Run All".
const UPSTREAM_OPEN_TIMEOUT_MS = 10_000;

// Cap the pre-open buffer so a client flooding input while the upstream is slow
// to open can't grow it without bound. Dropping a few keystrokes here is benign
// next to an unbounded buffer — and the open timeout above tears the connection
// down well before this matters in practice.
const MAX_PENDING_FRAMES = 1_000;

// Proxies a terminal WebSocket from the UI through to the terminal server.
// Bidirectional relay; either side closing tears down both ends.
export function proxyTerminalWs(
  clientWs: WebSocket,
  reqUrl: string | undefined,
) {
  // The client socket may already be gone by the time we're wired up. The
  // caller (`buildTerminalWss`) awaits `ensureTerminalServer()` first — up to
  // ~5s if the terminal-server must actually be spawned — and a user closing
  // the tab during that window fires the browser socket's 'close' *before* our
  // `clientWs.on('close')` below exists to hear it, so that close is dropped
  // and the handler we register now would never fire. Opening the upstream
  // regardless would leak the socket plus a dead terminal-server subscriber
  // (attach-by-id) or spawn a brand-new PTY for a client that is already gone
  // (no-id). Bail before opening anything upstream if the client isn't live.
  if (
    clientWs.readyState !== WebSocket.OPEN &&
    clientWs.readyState !== WebSocket.CONNECTING
  ) {
    return;
  }

  const params = new URL(reqUrl ?? '', 'http://localhost').searchParams;
  if (!params.get('id') && params.has('initialCommand')) {
    params.set('initialCommand', withCodexActivityTitle(params.get('initialCommand')!)!);
  }
  const targetWs = new WebSocket(
    `ws://127.0.0.1:${TERMINAL_PORT}/ws/terminal?${params.toString()}`,
  );

  // Which pty this socket drives. Usually right there in the query; a
  // SERVERLESS connect (no id — a startup terminal, or a pre-spawn that failed)
  // learns it from the `attached` frame the terminal-server sends first.
  let sessionId = params.get('id');
  const activityObserver = createTerminalActivityRelayObserver();

  // Buffer messages that arrive before the upstream connection is open.
  const pending: Array<{ data: RawData; isBinary: boolean }> = [];

  // Watchdog: if upstream never opens, drop the client so it reconnects.
  // clearTimeout is a no-op after the timer fires, so every teardown path can
  // call it unconditionally without tracking whether it already ran.
  const openTimer = setTimeout(() => {
    if (targetWs.readyState === WebSocket.OPEN) return;
    activityObserver.dispose();
    console.warn(
      `[terminal-proxy] upstream did not open within ${UPSTREAM_OPEN_TIMEOUT_MS}ms — dropping client so it reconnects`,
    );
    try {
      targetWs.terminate();
    } catch {
      /* ignore */
    }
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  }, UPSTREAM_OPEN_TIMEOUT_MS);
  // Don't let the watchdog alone keep the process alive.
  openTimer.unref();

  clientWs.on('message', (data: RawData, isBinary: boolean) => {
    // Every frame from the browser is something the user or the UI did —
    // a keystroke, a scroll's wheel escape, a focus report, a resize — and any
    // of them can make a full-screen harness repaint. Stamp it so the sidebar's
    // spinner doesn't read the pty answering the user as the agent working.
    // See terminalActivity.ts; this relay is the only place the main backend
    // sees the input side of a pty.
    if (sessionId) noteTerminalClientInput(sessionId);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
    } else if (pending.length < MAX_PENDING_FRAMES) {
      pending.push({ data, isBinary });
    }
  });

  targetWs.on('open', () => {
    clearTimeout(openTimer);
    // The client can still vanish between the guard above and the upstream
    // opening (its 'close' may even have fired before `clientWs.on('close')`
    // was registered). Don't keep a freshly-attached subscriber / spawned PTY
    // alive for a dead client — close the upstream and drop everything.
    if (clientWs.readyState !== WebSocket.OPEN) {
      activityObserver.dispose();
      const s = targetWs.readyState;
      if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
      return;
    }
    for (const { data, isBinary } of pending) {
      try {
        targetWs.send(data, { binary: isBinary });
      } catch {
        /* upstream dropped between open and flush — discard */
      }
    }
    pending.length = 0;
  });

  targetWs.on('message', (data: RawData, isBinary: boolean) => {
    // Observe the existing stream without another attach (which can resize the
    // PTY). Retained executors lack native title facts; replay restores the
    // latest title after a backend restart without restarting their sessions.
    if (!isBinary) {
      activityObserver.observe(data.toString());
      if (activityObserver.sessionId !== null) sessionId = activityObserver.sessionId;
    }
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  targetWs.on('error', (err) => {
    activityObserver.dispose();
    clearTimeout(openTimer);
    console.error('[terminal-proxy] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  targetWs.on('close', () => {
    activityObserver.dispose();
    clearTimeout(openTimer);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('close', () => {
    activityObserver.dispose();
    clearTimeout(openTimer);
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });

  clientWs.on('error', () => {
    activityObserver.dispose();
    clearTimeout(openTimer);
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });
}
