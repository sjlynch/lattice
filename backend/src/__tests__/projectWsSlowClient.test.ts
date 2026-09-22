import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import {
  buildProjectWss,
  PROJECT_WS_HIGH_WATER_BYTES,
} from '../ws/projectEndpoint.js';

// Slow-client safety net: a project WS whose unsent buffer passes
// PROJECT_WS_HIGH_WATER_BYTES is terminated instead of having yet another
// (possibly whole-board) frame queued onto the backend heap. The frontend
// reconnects and receives a fresh snapshot, so no protocol change.

const PROJECT = process.platform === 'win32' ? 'C:\\proj-ws-slow' : '/proj-ws-slow';

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = 0;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() {
    this.terminated++;
    this.readyState = 2; // CLOSING, as ws does synchronously
    queueMicrotask(() => { this.readyState = 3; this.emit('close'); });
  }
}

function setup() {
  const listeners = new Set<(ev: { n: number }) => void>();
  const wss = buildProjectWss<{ n: number }>({
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  const ws = new FakeWs();
  const req = { url: `/ws/x?project=${encodeURIComponent(PROJECT)}` } as IncomingMessage;
  wss.emit('connection', ws, req);
  return { ws, listeners, emit: (ev: { n: number }) => { for (const l of [...listeners]) l(ev); } };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

test('a healthy client receives forwarded events', async () => {
  const { ws, emit } = setup();
  await flush();
  emit({ n: 1 });
  ws.bufferedAmount = PROJECT_WS_HIGH_WATER_BYTES; // at the limit, not over
  emit({ n: 2 });
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ n: 1 }, { n: 2 }]);
  assert.equal(ws.terminated, 0);
});

test('a client over the high-water mark is terminated, not queued onto, and unsubscribed', async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const { ws, emit, listeners } = setup();
  await flush();
  assert.equal(listeners.size, 1);
  ws.bufferedAmount = PROJECT_WS_HIGH_WATER_BYTES + 1;
  emit({ n: 1 });
  emit({ n: 2 });
  assert.deepEqual(ws.sent, [], 'nothing more is queued');
  assert.equal(ws.terminated, 1);
  assert.equal(warnings.length, 1, 'logged once');
  await flush();
  assert.equal(listeners.size, 0, 'close tore the subscription down');
});
