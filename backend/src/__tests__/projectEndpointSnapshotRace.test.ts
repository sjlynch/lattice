import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type WebSocketServer } from 'ws';
import {
  buildProjectWss,
  MAX_INITIAL_SNAPSHOT_LOADS,
} from '../ws/projectEndpoint.js';

// Regression: `buildProjectWss` used to await the initial snapshot BEFORE
// subscribing, so an event fired during that await (a /ws/tasks change while
// `listTasks` ran) was lost until the next change. It now subscribes first,
// re-loads the snapshot when a snapshot event lands mid-load, and buffers
// delta events until the snapshot has been sent.

const PROJECT = process.platform === 'win32' ? 'C:\\proj-ws-race' : '/proj-ws-race';

type Ev =
  | { kind: 'snapshot'; version: number }
  | { kind: 'delta'; n: number };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A fake store: `state` is the live version; `emit` fans out to listeners.
function makeSource() {
  const listeners = new Set<(ev: Ev) => void>();
  const loads: Array<Deferred<void>> = [];
  const src = {
    state: 1,
    listeners,
    loads,
    // Resolves once at least `n` loads have started.
    async waitForLoads(n: number): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (loads.length < n) {
        if (Date.now() > deadline) throw new Error(`only ${loads.length}/${n} loads started`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    emit(ev: Ev) { for (const l of [...listeners]) l(ev); },
    // Each load snapshots `state` at the moment it is released, like a real
    // async read that observes whatever is current when it completes.
    async load(): Promise<{ type: 'snap'; version: number }> {
      const gate = deferred<void>();
      loads.push(gate);
      await gate.promise;
      return { type: 'snap', version: src.state };
    },
  };
  return src;
}

function buildWss(src: ReturnType<typeof makeSource>, withClassifier = true): WebSocketServer {
  return buildProjectWss<Ev>({
    initial: () => src.load(),
    initialError: 'ignore',
    subscribe: (listener) => {
      src.listeners.add(listener);
      return () => { src.listeners.delete(listener); };
    },
    payloadFromEvent: (ev) =>
      ev.kind === 'snapshot'
        ? { type: 'snap', version: ev.version }
        : { type: 'delta', n: ev.n },
    ...(withClassifier ? { isSnapshotEvent: (ev: Ev) => ev.kind === 'snapshot' } : {}),
  });
}

async function startServer(wss: WebSocketServer) {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}/ws/x?project=${encodeURIComponent(PROJECT)}`;
  return {
    url,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
}

function collect(client: WebSocket): unknown[] {
  const got: unknown[] = [];
  client.on('message', (data) => got.push(JSON.parse(String(data))));
  return got;
}

async function open(url: string): Promise<{ client: WebSocket; got: unknown[] }> {
  const client = new WebSocket(url);
  const got = collect(client);
  await new Promise<void>((res, rej) => { client.once('open', () => res()); client.once('error', rej); });
  return { client, got };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('a snapshot event fired while the initial load is pending is reflected (re-load)', async () => {
  const src = makeSource();
  const srv = await startServer(buildWss(src));
  try {
    const { client, got } = await open(srv.url);
    await src.waitForLoads(1);
    assert.equal(src.listeners.size, 1, 'subscribed before the snapshot load');

    // A change is announced while the first load is in flight; that load
    // still returns the old version 1 (a stale read).
    src.emit({ kind: 'snapshot', version: 2 });
    src.loads[0]!.resolve();
    await tick();
    // The first load returned version 1 (state not yet bumped) — stale.
    src.state = 2;
    assert.equal(src.loads.length, 2, 'the mid-load snapshot event forced a re-load');
    assert.deepEqual(got, [], 'the stale first load was not sent');
    src.loads[1]!.resolve();
    await tick();

    assert.deepEqual(got, [{ type: 'snap', version: 2 }]);

    // Afterwards events flow normally.
    src.state = 3;
    src.emit({ kind: 'snapshot', version: 3 });
    await tick();
    assert.deepEqual(got, [{ type: 'snap', version: 2 }, { type: 'snap', version: 3 }]);
    client.close();
  } finally {
    await srv.close();
  }
});

test('delta events during the load are buffered and flushed after the snapshot', async () => {
  const src = makeSource();
  const srv = await startServer(buildWss(src));
  try {
    const { client, got } = await open(srv.url);
    await src.waitForLoads(1);
    src.emit({ kind: 'delta', n: 1 });
    src.emit({ kind: 'delta', n: 2 });
    await tick();
    assert.deepEqual(got, [], 'nothing is forwarded before the snapshot');
    src.loads[0]!.resolve();
    await tick();
    assert.equal(src.loads.length, 1, 'deltas do not force a re-load');
    assert.deepEqual(got, [
      { type: 'snap', version: 1 },
      { type: 'delta', n: 1 },
      { type: 'delta', n: 2 },
    ]);
    client.close();
  } finally {
    await srv.close();
  }
});

test('re-loads are capped; the latest loaded snapshot is sent, never an older event', async () => {
  const src = makeSource();
  const srv = await startServer(buildWss(src));
  try {
    const { client, got } = await open(srv.url);
    for (let i = 0; i < MAX_INITIAL_SNAPSHOT_LOADS; i++) {
      await src.waitForLoads(i + 1);
      src.state += 1;
      // A snapshot event carrying an OLDER version than the load will observe.
      src.emit({ kind: 'snapshot', version: src.state - 1 });
      src.loads[i]!.resolve();
    }
    await tick();
    assert.equal(src.loads.length, MAX_INITIAL_SNAPSHOT_LOADS);
    assert.deepEqual(got, [{ type: 'snap', version: src.state }]);
    client.close();
  } finally {
    await srv.close();
  }
});

test('a socket closed mid-load unsubscribes and sends nothing', async () => {
  const src = makeSource();
  const srv = await startServer(buildWss(src));
  try {
    const { client, got } = await open(srv.url);
    await src.waitForLoads(1);
    assert.equal(src.listeners.size, 1);
    client.close();
    await new Promise((r) => client.once('close', r));
    await tick();
    assert.equal(src.listeners.size, 0, 'no leaked listener');
    src.loads[0]!.resolve();
    await tick();
    assert.equal(src.loads.length, 1);
    assert.deepEqual(got, []);
  } finally {
    await srv.close();
  }
});

test('without a classifier every mid-load event is buffered, not dropped', async () => {
  const src = makeSource();
  const srv = await startServer(buildWss(src, false));
  try {
    const { client, got } = await open(srv.url);
    await src.waitForLoads(1);
    src.emit({ kind: 'snapshot', version: 9 });
    src.loads[0]!.resolve();
    await tick();
    assert.deepEqual(got, [{ type: 'snap', version: 1 }, { type: 'snap', version: 9 }]);
    client.close();
  } finally {
    await srv.close();
  }
});
