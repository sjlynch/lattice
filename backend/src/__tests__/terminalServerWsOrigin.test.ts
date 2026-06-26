import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { attachTerminalWebSocketUpgrade } from '../terminalServer/websocket.js';

// Regression: the detached terminal-server (:5185) owns the pty and runs an
// attacker-controllable `initialCommand` on a fresh session, so a drive-by page
// reaching its /ws/terminal upgrade is arbitrary command execution. WebSocket
// handshakes are NOT subject to same-origin policy, so the upgrade handler must
// reject any browser-supplied Origin outside the loopback:5183 allowlist BEFORE
// handing the socket to the session machinery — mirroring the main server's
// gate (`ws/wsServer.ts`). Absent-Origin clients (the node relay / curl that the
// proxy uses) carry NO Origin header and must still be allowed, or every
// legitimate terminal breaks. See LATTICE_TASK t_1782431131124_8oajx.

type Harness = {
  port: number;
  /** True once the tracking wss would have created a session (connection event). */
  connected: () => boolean;
  close: () => Promise<void>;
};

async function startHarness(): Promise<Harness> {
  const server = http.createServer();
  // A stand-in for createTerminalWebSocketServer()'s wss: we only need to know
  // whether a connection (== a session) would have been established. Using a
  // tracking wss avoids spawning a real pty in the test.
  const wss = new WebSocketServer({ noServer: true });
  let didConnect = false;
  const serverSockets = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    didConnect = true;
    serverSockets.add(ws);
    ws.once('close', () => serverSockets.delete(ws));
  });

  attachTerminalWebSocketUpgrade(server, wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    connected: () => didConnect,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of serverSockets) ws.terminate();
        server.close(() => resolve());
      }),
  };
}

/** Attempt a handshake; resolve 'opened' if it upgrades, 'rejected' if not. */
function attempt(
  url: string,
  opts?: { origin?: string },
): Promise<'opened' | 'rejected'> {
  return new Promise((resolve) => {
    const client = new WebSocket(url, opts);
    client.once('open', () => {
      client.close();
      resolve('opened');
    });
    // A destroyed socket during the upgrade surfaces as 'error' (ECONNRESET) or
    // 'unexpected-response'; either way the handshake did not complete.
    client.once('error', () => resolve('rejected'));
    client.once('unexpected-response', () => {
      client.terminate();
      resolve('rejected');
    });
  });
}

test('terminal-server WS upgrade rejects a cross-site Origin and creates no session', async () => {
  const h = await startHarness();
  try {
    const result = await attempt(
      `ws://127.0.0.1:${h.port}/ws/terminal?cwd=${encodeURIComponent('C:\\')}&initialCommand=calc.exe`,
      { origin: 'http://evil.com' },
    );
    assert.equal(result, 'rejected', 'a cross-site Origin must be rejected');
    // Give any erroneously-emitted connection a tick to land before asserting.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      h.connected(),
      false,
      'no session may be created for a disallowed Origin',
    );
  } finally {
    await h.close();
  }
});

test('terminal-server WS upgrade allows an absent Origin (node relay / curl)', async () => {
  const h = await startHarness();
  try {
    // The `ws` client sends NO Origin header unless `origin` is set — exactly
    // how proxyTerminalWs / curl connect.
    const result = await attempt(`ws://127.0.0.1:${h.port}/ws/terminal`);
    assert.equal(result, 'opened', 'an absent Origin must be allowed');
    assert.equal(h.connected(), true, 'a session is created for the relay');
  } finally {
    await h.close();
  }
});

test('terminal-server WS upgrade allows a loopback:5183 Origin', async () => {
  const h = await startHarness();
  try {
    const result = await attempt(`ws://127.0.0.1:${h.port}/ws/terminal`, {
      origin: 'http://127.0.0.1:5183',
    });
    assert.equal(result, 'opened', 'the app origin must be allowed');
    assert.equal(h.connected(), true, 'a session is created for the app');
  } finally {
    await h.close();
  }
});
