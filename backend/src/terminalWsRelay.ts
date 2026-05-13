import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { TERMINAL_PORT } from './terminalServerLifecycle.js';

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

  clientWs.on('message', (data: RawData, isBinary: boolean) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
    } else {
      pending.push({ data, isBinary });
    }
  });

  targetWs.on('open', () => {
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
    console.error('[terminal-proxy] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  targetWs.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('close', () => {
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });

  clientWs.on('error', () => {
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });
}
