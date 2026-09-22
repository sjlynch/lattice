import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { attachTerminalWebSocketUpgrade } from '../terminalServer/websocket.js';
import { isPtyDimension, MAX_PTY_DIMENSION } from '../terminal/attach.js';

// Regression: the terminal-server's upgrade listener parsed `req.url` with an
// unguarded `new URL()`. An absolute-form target like `http://[` passes Node's
// HTTP parser but makes `new URL()` throw — an uncaughtException in the
// detached executor, which takes every live agent pty down with it.

test('terminal-server refuses a malformed upgrade target without throwing', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let connected = false;
  wss.on('connection', () => { connected = true; });
  attachTerminalWebSocketUpgrade(server, wss);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    await new Promise<void>((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write(
          'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\n' +
            'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      c.on('error', () => { /* destroyed by the server — expected */ });
      c.on('close', () => resolve());
      setTimeout(() => reject(new Error('socket was never closed')), 5000).unref();
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(uncaught, []);
    assert.equal(connected, false);
  } finally {
    process.off('uncaughtException', onUncaught);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('isPtyDimension rejects sizes past the ConPTY 16-bit limit', () => {
  assert.equal(isPtyDimension(80), true);
  assert.equal(isPtyDimension(MAX_PTY_DIMENSION), true);
  assert.equal(isPtyDimension(MAX_PTY_DIMENSION + 1), false);
  assert.equal(isPtyDimension(1e9), false);
});
