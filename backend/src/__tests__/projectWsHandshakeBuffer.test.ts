import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import {
  buildProjectWss,
  PROJECT_WS_MAX_PENDING_BYTES,
  PROJECT_WS_MAX_PENDING_EVENTS,
  type ProjectEventListener,
  type Unsubscribe,
} from '../ws/projectEndpoint.js';

// Regression: a stalled initial load buffered unlimited events even with
// bufferedAmount = 0. Closing also left queued events and the fallback snapshot
// retained by that load, and late subscription callbacks could enqueue more.

const PROJECT = process.platform === 'win32' ? 'C:\\proj-ws-handshake' : '/proj-ws-handshake';
const OTHER_PROJECT = `${PROJECT}-other`;
type Payload = { type: 'snapshot' | 'delta'; n?: number; text?: string };
type Ev = { projectPath: string; payload: Payload };
const delta = (n: number, projectPath = PROJECT): Ev => ({ projectPath, payload: { type: 'delta', n } });
const snapshot = (n: number): Ev => ({ projectPath: PROJECT, payload: { type: 'snapshot', n } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = 0;
  closes = 0;
  send(data: string) { this.sent.push(data); }
  close() { this.closes++; this.readyState = 3; this.emit('close'); }
  terminate() {
    this.terminated++;
    this.readyState = 2;
    // Deliberately delay 'close': overflow must release its subscription now.
  }
}

// Yield one event-loop turn, without timers or polling a real server.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(options: {
  subscribeLater?: boolean;
  initialError?: 'close' | 'ignore';
  loadInitial?: () => Promise<unknown>;
} = {}) {
  const initial = deferred<unknown>();
  const subscription = deferred<Unsubscribe>();
  const listeners = new Set<ProjectEventListener<Ev>>();
  let lastListener!: ProjectEventListener<Ev>;
  let unsubscribed = 0;
  let serialized = 0;
  let loads = 0;
  const wss = buildProjectWss<Ev>({
    initial: () => { loads++; return options.loadInitial ? options.loadInitial() : initial.promise; },
    initialError: options.initialError,
    subscribe: (listener) => {
      listeners.add(listener);
      lastListener = listener;
      const unsubscribe = () => { unsubscribed++; listeners.delete(listener); };
      if (options.subscribeLater) return subscription.promise;
      return unsubscribe;
    },
    projectFromEvent: (event) => event.projectPath,
    isSnapshotEvent: (event) => event.payload.type === 'snapshot',
    payloadFromEvent: (event) => { serialized++; return event.payload; },
  });
  const connect = () => {
    const ws = new FakeWs();
    const req = { url: `/ws/x?project=${encodeURIComponent(PROJECT)}` } as IncomingMessage;
    wss.emit('connection', ws, req);
    return ws;
  };
  const ws = connect();
  return {
    ws, connect, initial, listeners,
    emit: (event: Ev) => { for (const listener of [...listeners]) listener(event); },
    lateEvent: (event: Ev) => lastListener(event),
    resolveSubscription: () => subscription.resolve(() => { unsubscribed++; listeners.delete(lastListener); }),
    get unsubscribed() { return unsubscribed; },
    get serialized() { return serialized; },
    get loads() { return loads; },
  };
}

function sizedEvent(bytes: number, type: Payload['type'] = 'delta'): Ev {
  const overhead = Buffer.byteLength(JSON.stringify({ type, text: '' }), 'utf8');
  const textBytes = bytes - overhead;
  // Multibyte text proves the budget measures bytes, not JS string length.
  const text = 'é'.repeat(Math.floor(textBytes / 2)) + 'x'.repeat(textBytes % 2);
  const event = { projectPath: PROJECT, payload: { type, text } };
  assert.equal(Buffer.byteLength(JSON.stringify(event.payload), 'utf8'), bytes);
  return event;
}

test('handshake count overflow terminates and unsubscribes once before close, with harmless late completion', async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const source = setup();
  await tick();
  const event = delta(1);
  for (let n = 0; n < PROJECT_WS_MAX_PENDING_EVENTS; n++) source.emit(event);
  assert.equal(source.ws.terminated, 0, 'exact count limit is allowed');
  assert.equal(source.ws.bufferedAmount, 0, 'send-buffer protection cannot catch this');
  source.emit(event);
  assert.equal(source.ws.terminated, 1);
  assert.equal(source.unsubscribed, 1, 'cleanup does not wait for close');
  assert.equal(source.listeners.size, 0);
  assert.equal(warnings.length, 1);
  const serialized = source.serialized;
  // Even if terminate throws or does not change readyState, closed owns the fence.
  source.ws.readyState = source.ws.OPEN;
  for (let n = 0; n < PROJECT_WS_MAX_PENDING_EVENTS + 1; n++) source.lateEvent(delta(n));
  assert.equal(source.serialized, serialized, 'late callbacks cannot process or buffer events');
  source.initial.resolve({ type: 'initial' });
  await tick();
  assert.deepEqual(source.ws.sent, []);
  assert.equal(source.loads, 1);
  source.ws.close();
  source.ws.emit('close');
  assert.equal(source.unsubscribed, 1);
  assert.equal(source.ws.terminated, 1);
  assert.equal(warnings.length, 1);
});

test('handshake byte overflow allows the exact UTF-8 budget, then terminates with bufferedAmount zero', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const source = setup();
  await tick();
  source.emit(sizedEvent(PROJECT_WS_MAX_PENDING_BYTES));
  assert.equal(source.ws.terminated, 0);
  source.emit(delta(2));
  assert.equal(source.ws.terminated, 1);
  assert.equal(source.ws.bufferedAmount, 0);
  assert.equal(source.unsubscribed, 1);
  source.initial.resolve({ type: 'initial' });
  await tick();
  assert.deepEqual(source.ws.sent, []);
});

test('a single over-budget fallback snapshot also terminates during the initial load', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const source = setup({ initialError: 'ignore' });
  await tick();
  source.emit(sizedEvent(PROJECT_WS_MAX_PENDING_BYTES + 1, 'snapshot'));
  assert.equal(source.ws.terminated, 1);
  assert.equal(source.unsubscribed, 1);
  source.initial.reject(new Error('late initial failure'));
  await tick();
  assert.deepEqual(source.ws.sent, []);
  assert.equal(source.ws.closes, 0, 'late failure does not close again');
});

test('healthy handshakes send the initial snapshot then every transient in FIFO order, filtering other projects', async () => {
  const source = setup();
  await tick();
  const first = delta(1);
  const second = delta(2);
  source.emit(first);
  source.emit({ ...sizedEvent(PROJECT_WS_MAX_PENDING_BYTES + 1), projectPath: OTHER_PROJECT });
  source.emit(second);
  assert.deepEqual(source.ws.sent, [], 'nothing precedes the initial snapshot');
  assert.equal(source.serialized, 2, 'other-project events are filtered before measuring');
  assert.equal(source.ws.terminated, 0);
  source.initial.resolve({ type: 'initial' });
  await tick();
  assert.deepEqual(source.ws.sent.map((frame) => JSON.parse(frame)), [
    { type: 'initial' }, first.payload, second.payload,
  ]);
  assert.equal(source.loads, 1, 'transients do not invalidate the load');
  const third = delta(3);
  source.emit(third);
  assert.deepEqual(JSON.parse(source.ws.sent[3]!), third.payload, 'events forward after settlement');
  source.ws.close();
});

test('snapshot replacement releases its byte allowance and ignore uses the latest fallback before FIFO transients', async () => {
  const source = setup({ initialError: 'ignore' });
  await tick();
  const largeSnapshot = sizedEvent(PROJECT_WS_MAX_PENDING_BYTES / 2, 'snapshot');
  const transient = sizedEvent(PROJECT_WS_MAX_PENDING_BYTES / 2);
  source.emit(largeSnapshot);
  source.emit(transient);
  source.emit(largeSnapshot);
  assert.equal(source.ws.terminated, 0, 'replacement does not double-count snapshot bytes');
  const latest = snapshot(2);
  const second = delta(2);
  source.emit(latest);
  source.emit(second);
  source.initial.reject(new Error('initial unavailable'));
  await tick();
  assert.deepEqual(source.ws.sent.map((frame) => JSON.parse(frame)), [
    latest.payload, transient.payload, second.payload,
  ]);
  assert.equal(source.ws.terminated, 0);
  source.ws.close();
});

test('snapshot reload releases its byte allowance while retaining buffered transients', async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const loads = [first, second];
  const source = setup({ loadInitial: () => loads.shift()!.promise });
  await tick();
  const transient = sizedEvent(PROJECT_WS_MAX_PENDING_BYTES / 2);
  source.emit(sizedEvent(PROJECT_WS_MAX_PENDING_BYTES / 2, 'snapshot'));
  source.emit(transient);
  first.resolve({ type: 'initial', n: 1 });
  await tick();
  assert.equal(source.loads, 2);
  assert.deepEqual(source.ws.sent, [], 'the dirty first load is not sent');
  source.emit(transient);
  assert.equal(source.ws.terminated, 0, 'the discarded fallback snapshot no longer consumes bytes');
  second.resolve({ type: 'initial', n: 2 });
  await tick();
  assert.deepEqual(source.ws.sent.map((frame) => JSON.parse(frame)), [
    { type: 'initial', n: 2 }, transient.payload, transient.payload,
  ]);
  source.ws.close();
});

test('ignore retains the last successful initial load when a reload fails', async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const loads = [first, second];
  const source = setup({ initialError: 'ignore', loadInitial: () => loads.shift()!.promise });
  await tick();
  source.emit(snapshot(1));
  source.emit(delta(1));
  first.resolve({ type: 'initial', n: 2 });
  await tick();
  source.emit(snapshot(1));
  second.reject(new Error('reload failed'));
  await tick();
  assert.equal(source.loads, 2);
  assert.deepEqual(source.ws.sent.map((frame) => JSON.parse(frame)), [
    { type: 'initial', n: 2 }, { type: 'delta', n: 1 },
  ]);
  source.ws.close();
});

test('initial failure closes by default without forwarding retained events', async () => {
  const source = setup();
  await tick();
  source.emit(delta(1));
  source.emit(snapshot(2));
  source.initial.reject(new Error('initial failed'));
  await tick();
  assert.equal(source.ws.closes, 1);
  assert.equal(source.unsubscribed, 1);
  assert.equal(source.listeners.size, 0);
  assert.deepEqual(source.ws.sent, []);
});

test('close during an initial load ignores late events and rejection without another teardown', async () => {
  const source = setup();
  await tick();
  source.emit(delta(1));
  source.emit(snapshot(2));
  source.ws.close();
  assert.equal(source.unsubscribed, 1);
  assert.equal(source.listeners.size, 0);
  const serialized = source.serialized;
  source.lateEvent(delta(3));
  source.lateEvent(snapshot(4));
  assert.equal(source.serialized, serialized, 'closed callbacks cannot grow the handshake buffer');
  source.initial.reject(new Error('late rejection'));
  await tick();
  assert.equal(source.ws.closes, 1);
  assert.deepEqual(source.ws.sent, []);
  source.ws.emit('close');
  assert.equal(source.unsubscribed, 1);
});

test('non-OPEN sockets ignore events and initial completion before the close event arrives', async () => {
  const source = setup();
  await tick();
  source.emit(delta(1));
  source.ws.readyState = 2;
  const serialized = source.serialized;
  source.lateEvent(delta(2));
  source.lateEvent(snapshot(3));
  source.initial.resolve({ type: 'initial' });
  await tick();
  assert.equal(source.serialized, serialized);
  assert.deepEqual(source.ws.sent, []);
  assert.equal(source.loads, 1);
  source.ws.close();
  assert.equal(source.unsubscribed, 1);
});

test('close before asynchronous subscribe returns releases its eventual unsubscribe without starting a load', async () => {
  const source = setup({ subscribeLater: true });
  source.emit(delta(1));
  source.emit(snapshot(2));
  source.ws.close();
  const serialized = source.serialized;
  source.lateEvent(delta(3));
  assert.equal(source.serialized, serialized);
  source.resolveSubscription();
  await tick();
  assert.equal(source.unsubscribed, 1);
  assert.equal(source.listeners.size, 0);
  assert.equal(source.loads, 0);
  assert.deepEqual(source.ws.sent, []);
  source.ws.emit('close');
  assert.equal(source.unsubscribed, 1);
});

test('overflow before asynchronous subscribe returns cleans up its eventual subscription once', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const source = setup({ subscribeLater: true });
  const event = delta(1);
  for (let n = 0; n <= PROJECT_WS_MAX_PENDING_EVENTS; n++) source.emit(event);
  assert.equal(source.ws.terminated, 1);
  assert.equal(source.unsubscribed, 0, 'unsubscribe has not arrived yet');
  const serialized = source.serialized;
  source.lateEvent(delta(2));
  assert.equal(source.serialized, serialized);
  source.resolveSubscription();
  await tick();
  assert.equal(source.unsubscribed, 1);
  assert.equal(source.listeners.size, 0);
  assert.equal(source.loads, 0);
  source.ws.close();
  assert.equal(source.unsubscribed, 1);
});

test('handshake measurement and forwarding reuse serialization across connections', async () => {
  const source = setup();
  const second = source.connect();
  await tick();
  source.emit(delta(1));
  assert.equal(source.serialized, 1, 'the broadcast payload is serialized once for both queues');
  source.initial.resolve({ type: 'initial' });
  await tick();
  assert.equal(source.serialized, 1, 'draining reuses the same shared cache');
  assert.deepEqual(source.ws.sent, second.sent);
  assert.deepEqual(source.ws.sent.map((frame) => JSON.parse(frame)), [
    { type: 'initial' }, { type: 'delta', n: 1 },
  ]);
  source.ws.close();
  second.close();
  assert.equal(source.unsubscribed, 2);
});
