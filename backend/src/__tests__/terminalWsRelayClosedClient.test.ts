import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

// Regression: closing the browser terminal WS while `buildTerminalWss` is still
// awaiting `ensureTerminalServer()` used to leak the upstream socket / spawn a
// PTY for a client that is already gone. The client's 'close' fires (and is
// dropped) before `proxyTerminalWs` registers its own close handler, so the
// relay would open the upstream, attach/spawn a session, and never tear it
// down. The fix bails in `proxyTerminalWs` when the client is no longer live
// (and re-checks once the upstream opens). Here we stand up a fake
// terminal-server upstream and assert an already-closed client produces NO
// upstream connection, while a live client still does.

type Upstream = {
  server: http.Server;
  port: number;
  /** How many /ws/terminal upgrades the fake terminal-server has accepted. */
  connections: () => number;
  close: () => Promise<void>;
};

async function startUpstream(): Promise<Upstream> {
  let connections = 0;
  const sockets = new Set<Duplex>();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', () => {
    connections += 1;
  });
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// A throwaway server that accepts client connections and holds them open, so
// we can produce a real WebSocket in either OPEN or CLOSED state to stand in
// for the browser socket.
async function startClientHolder(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', () => {
    /* hold it open */
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}

async function openClient(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return ws;
}

test('proxyTerminalWs does not open an upstream session for an already-closed client', async () => {
  const upstream = await startUpstream();
  const holder = await startClientHolder();
  // Point the relay at our fake terminal-server, then import it (the module
  // reads TERMINAL_PORT at load time).
  process.env.TERMINAL_PORT = String(upstream.port);
  const { proxyTerminalWs } = await import('../terminalWsRelay.js');

  try {
    // --- The bug: a client that closed during the pre-relay await. ---
    const closed = await openClient(holder.url);
    await new Promise<void>((res) => {
      closed.once('close', () => res());
      closed.close();
    });
    assert.equal(
      closed.readyState,
      WebSocket.CLOSED,
      'client should be fully closed before wiring the relay',
    );

    const before = upstream.connections();
    proxyTerminalWs(closed, '/ws/terminal?id=already-gone');
    // Give any (erroneous) upstream connection ample time to land.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      upstream.connections(),
      before,
      'no upstream session should be created/attached for a gone client',
    );

    // --- Positive control: a live client still proxies through. ---
    const live = await openClient(holder.url);
    proxyTerminalWs(live, '/ws/terminal?id=live');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      upstream.connections(),
      before + 1,
      'a live client should open exactly one upstream session',
    );
    live.terminate();
  } finally {
    await holder.close();
    await upstream.close();
  }
});
