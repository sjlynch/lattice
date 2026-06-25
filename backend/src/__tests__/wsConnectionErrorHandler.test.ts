import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, type WebSocketServer } from 'ws';
import { buildProjectWss } from '../ws/projectEndpoint.js';
import { buildHarnessesWss } from '../ws/endpoints/harnesses.js';

// Regression: a project/terminal/harness WS connection must register an
// 'error' listener. In ws v8 an underlying socket error (ECONNRESET/EPIPE
// from an abruptly-killed tab, network partition, OS sleep, or a vite-proxy
// hard-drop) makes the WebSocket emit('error', …). With NO listener, Node's
// EventEmitter re-throws it as a process-level uncaughtException — which the
// catch-all in processGuards.ts mislabels as a fatal `[lattice]
// uncaughtException`, and which would crash the backend outright the moment
// that guard is ever tightened to exit on real bugs. See LATTICE_TASK
// t_1782412465078_2qwn3.

type Harness = {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  /** The raw upgraded socket ws is wrapping for the most recent connection. */
  lastRawSocket: () => Duplex | null;
  /** Resolves with the server-side WebSocket once a connection lands. */
  nextConnection: () => Promise<WebSocket>;
  close: () => Promise<void>;
};

async function startHarness(wss: WebSocketServer): Promise<Harness> {
  const server = http.createServer();
  let rawSocket: Duplex | null = null;
  const sockets = new Set<Duplex>();
  const connectionWaiters: Array<(ws: WebSocket) => void> = [];

  wss.on('connection', (ws) => {
    const waiter = connectionWaiters.shift();
    if (waiter) waiter(ws);
  });

  server.on('upgrade', (req, socket, head) => {
    // The socket handed to handleUpgrade IS the one ws wraps — capture it so
    // the test can drive a realistic socket-level failure against it.
    rawSocket = socket;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    wss,
    port,
    lastRawSocket: () => rawSocket,
    nextConnection: () =>
      new Promise<WebSocket>((resolve) => connectionWaiters.push(resolve)),
    // Force-destroy any lingering upgraded socket before closing — otherwise an
    // assertion that fails while a client is still connected would leave
    // server.close() waiting forever, turning a clean failure into a hang.
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

async function openClient(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  return client;
}

/**
 * Run `body` while watching for any process-level uncaughtException, and
 * return the list of captured errors. Our own listener also prevents the
 * default crash, so a regression surfaces as a returned error rather than
 * killing the whole test run.
 */
async function captureUncaught(body: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    await body();
    // Give a freshly-emitted uncaughtException a tick to land before we assert.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return uncaught;
}

test('a socket error on a project WS connection does not surface as uncaughtException', async () => {
  // No-op subscription: the connection just needs to be established.
  const wss = buildProjectWss<{ projectPath: string }>({
    subscribe: () => () => {},
  });
  const h = await startHarness(wss);

  try {
    const uncaught = await captureUncaught(async () => {
      const connected = h.nextConnection();
      const client = await openClient(
        `ws://127.0.0.1:${h.port}/ws/tasks?project=${encodeURIComponent('/tmp/p')}`,
      );
      const serverWs = await connected;

      // The connection MUST have registered an 'error' listener — that is the
      // whole fix. Without it the destroy below re-throws as uncaughtException.
      assert.ok(
        serverWs.listenerCount('error') > 0,
        'project WS connection should register an error listener',
      );

      const raw = h.lastRawSocket();
      assert.ok(raw, 'server should have captured the raw upgraded socket');

      // Destroying the socket WITH an error reproduces a real ECONNRESET: the
      // socket emits 'error' from the event loop, which ws re-emits on the
      // WebSocket. We deliberately do NOT await the socket 'close' here — when
      // the fix is absent the re-thrown error disrupts teardown and 'close'
      // may never fire, which would HANG the test instead of failing it. The
      // captureUncaught settle delay bounds the wait either way.
      raw!.destroy(new Error('ECONNRESET'));
      client.terminate();
    });

    assert.deepEqual(
      uncaught,
      [],
      'a routine client disconnect must not crash the process',
    );
  } finally {
    await h.close();
  }
});

test('a socket error on the /ws/harnesses connection does not surface as uncaughtException', async () => {
  const wss = buildHarnessesWss();
  const h = await startHarness(wss);

  try {
    const uncaught = await captureUncaught(async () => {
      const connected = h.nextConnection();
      const client = await openClient(`ws://127.0.0.1:${h.port}/ws/harnesses`);
      const serverWs = await connected;

      assert.ok(
        serverWs.listenerCount('error') > 0,
        'harnesses WS connection should register an error listener',
      );

      const raw = h.lastRawSocket();
      assert.ok(raw, 'server should have captured the raw upgraded socket');

      raw!.destroy(new Error('ECONNRESET'));
      client.terminate();
    });

    assert.deepEqual(
      uncaught,
      [],
      'a routine client disconnect must not crash the process',
    );
  } finally {
    await h.close();
  }
});
