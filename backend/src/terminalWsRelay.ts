import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { TERMINAL_PORT } from './terminalServerLifecycle.js';

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
  const params = new URL(reqUrl ?? '', 'http://localhost').searchParams;
  const targetWs = new WebSocket(
    `ws://127.0.0.1:${TERMINAL_PORT}/ws/terminal?${params.toString()}`,
  );

  // Buffer messages that arrive before the upstream connection is open.
  const pending: Array<{ data: RawData; isBinary: boolean }> = [];

  // Watchdog: if upstream never opens, drop the client so it reconnects.
  // clearTimeout is a no-op after the timer fires, so every teardown path can
  // call it unconditionally without tracking whether it already ran.
  const openTimer = setTimeout(() => {
    if (targetWs.readyState === WebSocket.OPEN) return;
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
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
    } else if (pending.length < MAX_PENDING_FRAMES) {
      pending.push({ data, isBinary });
    }
  });

  targetWs.on('open', () => {
    clearTimeout(openTimer);
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
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  targetWs.on('error', (err) => {
    clearTimeout(openTimer);
    console.error('[terminal-proxy] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  targetWs.on('close', () => {
    clearTimeout(openTimer);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('close', () => {
    clearTimeout(openTimer);
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });

  clientWs.on('error', () => {
    clearTimeout(openTimer);
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });
}
