// Fleet terminal control against a fake executor speaking the real attach
// protocol (`attached` → one `replayed` data frame → live frames; `input`
// frames from the client). Pins: an agent TUI's cursor-addressed redraw reads
// back as the screen a human sees; multi-line input goes as ONE bracketed
// paste and `submit` is a separate Enter; an unknown id (`session_lost`) is
// `not-found`; waiting resolves once output stops, and times out while it
// keeps coming; nothing ever sends `resize` or `kill`.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';

import { readTerminalScreen, renderTerminalText, sendTerminalInput, TerminalControlError, waitTerminalQuiet } from '../fleet/terminal.js';

type Fake = { port: number; received: Array<{ type: string; data?: string }>; sockets: WebSocket[]; close: () => Promise<void> };

async function fakeExecutor(replay: string, opts: { known?: boolean; cols?: number; rows?: number } = {}): Promise<Fake> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const received: Fake['received'] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    if (opts.known === false) {
      ws.send(JSON.stringify({ type: 'session_lost', message: 'gone' }));
      ws.close();
      return;
    }
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({ type: 'attached', id: 'p1', cols: opts.cols ?? 40, rows: opts.rows ?? 5, replayed: true }));
    ws.send(JSON.stringify({ type: 'data', data: replay, replayed: true }));
  });
  return {
    port: (wss.address() as AddressInfo).port,
    received,
    sockets,
    close: () => new Promise((r) => { for (const s of sockets) s.terminate(); wss.close(() => r()); }),
  };
}

test('renderTerminalText resolves cursor addressing into screen lines', async () => {
  const { screen, tail } = await renderTerminalText('first line\r\nsecond\x1b[1;7HLINE', 20, 4, 10);
  assert.equal(screen, 'first LINE\nsecond');
  assert.equal(tail, 'first LINE\nsecond');
});

test('readTerminalScreen renders the replay at the pty size and detaches without resize/kill', async () => {
  const fake = await fakeExecutor('\x1b[2J\x1b[Hhello agent\r\n> waiting for input', { cols: 30, rows: 4 });
  try {
    const s = await readTerminalScreen('p1', { port: fake.port, lines: 50 });
    assert.equal(s.cols, 30);
    assert.equal(s.rows, 4);
    assert.equal(s.screen, 'hello agent\n> waiting for input');
    assert.deepEqual(fake.received, []);
  } finally {
    await fake.close();
  }
});

test('sendTerminalInput: one bracketed paste for multi-line text, then a separate Enter', async () => {
  const fake = await fakeExecutor('');
  try {
    await sendTerminalInput('p1', 'line one\nline two', { submit: true, port: fake.port });
    assert.deepEqual(fake.received, [
      { type: 'input', data: '\x1b[200~line one\nline two\x1b[201~' },
      { type: 'input', data: '\r' },
    ]);
    fake.received.length = 0;
    await sendTerminalInput('p1', 'y', { port: fake.port });
    assert.deepEqual(fake.received, [{ type: 'input', data: 'y' }]);
  } finally {
    await fake.close();
  }
});

test('an unknown pty is not-found', async () => {
  const fake = await fakeExecutor('', { known: false });
  try {
    await assert.rejects(readTerminalScreen('nope', { port: fake.port }), (err: unknown) => err instanceof TerminalControlError && err.code === 'not-found');
  } finally {
    await fake.close();
  }
});

test('waitTerminalQuiet: idle once output stops; not idle while it keeps coming', async () => {
  const fake = await fakeExecutor('');
  try {
    const quiet = await waitTerminalQuiet('p1', { port: fake.port, quietMs: 500, timeoutMs: 5000 });
    assert.equal(quiet.idle, true);
    const chatter = setInterval(() => { for (const s of fake.sockets) s.send(JSON.stringify({ type: 'data', data: '.' })); }, 100);
    try {
      const busy = await waitTerminalQuiet('p1', { port: fake.port, quietMs: 800, timeoutMs: 1500 });
      assert.equal(busy.idle, false);
    } finally {
      clearInterval(chatter);
    }
  } finally {
    await fake.close();
  }
});
