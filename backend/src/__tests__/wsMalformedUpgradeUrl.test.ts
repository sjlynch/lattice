import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { attachWebSockets, upgradePathname } from '../ws/wsServer.js';
import { parseProject } from '../ws/projectEndpoint.js';

// Regression: an absolute-form request target such as `http://[` passes Node's
// HTTP parser but makes `new URL()` throw. The dispatcher parsed it unguarded
// inside the server's `upgrade` listener, so ONE malformed handshake (curl, a
// local port scanner — no Origin header needed) was an uncaughtException and
// processGuards exited the whole backend.

test('upgradePathname / parseProject tolerate a URL that new URL() rejects', () => {
  assert.equal(upgradePathname('http://['), null);
  assert.equal(upgradePathname('/ws/tasks?project=x'), '/ws/tasks');
  assert.equal(parseProject('http://['), '');
});

test('a malformed upgrade target is refused, not thrown out of the upgrade listener', async () => {
  const server = http.createServer();
  attachWebSockets(server);
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
    // Give a would-be async throw a tick to surface.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
