import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

// Two relay edges around the upstream open:
//  - frames the browser sent BEFORE proxyTerminalWs was wired (the caller was
//    awaiting ensureTerminalServer) are forwarded first and in order, not lost;
//  - a client that leaves while the upstream is still CONNECTING tears the
//    upstream down quietly — ws reports that abort as an 'error', and it is
//    not an upstream fault to log.
//
// One fake upstream for both (the relay reads TERMINAL_PORT once at module
// load): `id=hold` accepts the TCP connection but never finishes the
// WebSocket handshake; anything else is a normal upgrade.

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const received: string[] = [];
const held = new Set<Duplex>();
const upstream = http.createServer();
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => ws.on('message', (d) => received.push(d.toString())));
upstream.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '', 'http://localhost').searchParams.get('id') === 'hold') {
    held.add(socket);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
const oldPort = process.env.TERMINAL_PORT;
process.env.TERMINAL_PORT = String((upstream.address() as AddressInfo).port);
const { proxyTerminalWs } = await import('../terminalWsRelay.js');

test.after(async () => {
  for (const ws of wss.clients) ws.terminate();
  for (const s of held) s.destroy();
  await new Promise<void>((r) => { wss.close(); upstream.close(() => r()); });
  if (oldPort === undefined) delete process.env.TERMINAL_PORT; else process.env.TERMINAL_PORT = oldPort;
});

// A stand-in browser socket: a real ws in OPEN state whose server side we
// keep, so we can make the "browser" emit a frame (server → client message).
async function browserPair(): Promise<{ client: WebSocket; peer: WebSocket; close: () => Promise<void> }> {
  const server = http.createServer();
  const pairWss = new WebSocketServer({ server });
  const peerP = new Promise<WebSocket>((resolve) => pairWss.once('connection', resolve));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => { client.once('open', () => res()); client.once('error', rej); });
  const peer = await peerP;
  return {
    client,
    peer,
    close: () => new Promise<void>((resolve) => { client.terminate(); peer.terminate(); pairWss.close(); server.close(() => resolve()); }),
  };
}

test('frames captured before the relay was wired are forwarded upstream first, in order', async () => {
  const pair = await browserPair();
  try {
    proxyTerminalWs(pair.client, '/ws/terminal?id=x', {
      earlyFrames: [
        { data: Buffer.from('early-1'), isBinary: false },
        { data: Buffer.from('early-2'), isBinary: false },
      ],
    });
    // Sent while the upstream is still opening: must land after the early ones.
    pair.peer.send('later');
    await until(() => received.length >= 3);
    assert.deepEqual(received, ['early-1', 'early-2', 'later']);
  } finally {
    await pair.close();
  }
});

test('a client leaving while the upstream is still connecting is not logged as an upstream error', async () => {
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const pair = await browserPair();
  try {
    proxyTerminalWs(pair.client, '/ws/terminal?id=hold');
    await until(() => held.size === 1);
    // The browser goes away before the upstream opened.
    await new Promise<void>((r) => { pair.client.once('close', () => r()); pair.client.close(); });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(errors.filter((e) => e.includes('upstream error')), []);
  } finally {
    console.error = origError;
    await pair.close();
  }
});
