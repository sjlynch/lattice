import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeWs,
  wsReconnectDelay,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_CAP_MS,
  WS_STABLE_MS,
} from '../api/ws.ts';

// --- Fakes -----------------------------------------------------------------
//
// subscribeWs reaches for three globals — `WebSocket`, `window`, and the timer
// functions. We stub all three so the reconnect lifecycle can be driven by hand
// and the scheduled backoff delays inspected. A manual timer queue (rather than
// node:test mock timers) keeps the scheduled delay values directly assertable.

type Scheduled = { id: number; cb: () => void; delay: number };

let scheduled: Scheduled[] = [];
let nextTimerId = 1;
let realSetTimeout: typeof setTimeout;
let realClearTimeout: typeof clearTimeout;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  // Test-side drivers for the server lifecycle.
  serverAccept() {
    this.onopen?.();
  }
  serverDrop() {
    this.onclose?.();
  }
}

/** The socket created by the most recent connect(). */
function latestSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'expected a WebSocket to have been created');
  return ws;
}

/** Fire every currently-pending timer (snapshotting first so callbacks that
 *  schedule new timers don't run within the same drain). */
function fireAll() {
  const due = scheduled;
  scheduled = [];
  for (const s of due) s.cb();
}

/** The single timer pending while we wait to reconnect. */
function pendingReconnect(): Scheduled {
  assert.equal(
    scheduled.length,
    1,
    `expected exactly one pending reconnect timer, saw ${scheduled.length}`,
  );
  return scheduled[0];
}

beforeEach(() => {
  scheduled = [];
  nextTimerId = 1;
  FakeWebSocket.instances = [];
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((
    cb: () => void,
    delay: number,
  ) => {
    const handle: Scheduled = { id: nextTimerId++, cb, delay };
    scheduled.push(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = ((
    handle: Scheduled,
  ) => {
    scheduled = scheduled.filter((s) => s !== handle);
  }) as unknown as typeof clearTimeout;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { window: unknown }).window = {
    location: { protocol: 'http:', host: 'localhost:5184' },
  };
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  delete (globalThis as unknown as { window?: unknown }).window;
});

// --- wsReconnectDelay (pure curve) -----------------------------------------

test('wsReconnectDelay grows exponentially then saturates at the cap', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(wsReconnectDelay),
    [250, 500, 1000, 2000, 4000, 5000, 5000],
  );
  assert.equal(wsReconnectDelay(0), WS_RECONNECT_BASE_MS);
  assert.equal(wsReconnectDelay(6), WS_RECONNECT_CAP_MS);
});

// --- The regression: accept-then-immediate-close must keep backing off ------

test('accept-then-immediate-close grows the reconnect backoff (no tight loop)', () => {
  const teardown = subscribeWs('/ws/tasks', () => {});
  const delays: number[] = [];

  // Six rounds of: server accepts the upgrade, then drops it before it can
  // become stable. The stability timer (armed in onopen) must be cleared by
  // the close, so the attempt counter is NEVER reset and the delay must grow.
  for (let i = 0; i < 6; i++) {
    const ws = latestSocket();
    ws.serverAccept(); // arms the WS_STABLE_MS stability timer
    ws.serverDrop(); // clears it, then schedules the reconnect
    delays.push(pendingReconnect().delay);
    fireAll(); // reconnect -> connect() creates the next socket
  }

  // Strictly the documented exponential curve — not a flat 250ms loop, which
  // is exactly what the pre-fix `attempt = 0` on every onopen produced.
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 5000]);
  teardown();
});

// --- A genuinely healthy connection still resets the backoff ----------------

test('a connection that stays open past WS_STABLE_MS resets the backoff', () => {
  const teardown = subscribeWs('/ws/tasks', () => {});

  // Drive the backoff up with a few unstable cycles.
  for (let i = 0; i < 3; i++) {
    const ws = latestSocket();
    ws.serverAccept();
    ws.serverDrop();
    fireAll();
  }

  // This connection proves stable: open, then let the stability timer fire.
  const ws = latestSocket();
  ws.serverAccept();
  const stable = pendingReconnect(); // the only pending timer is the stability one
  assert.equal(stable.delay, WS_STABLE_MS);
  fireAll(); // stability window elapses -> attempt reset to 0

  // A subsequent drop now backs off from the base delay again.
  ws.serverDrop();
  assert.equal(pendingReconnect().delay, WS_RECONNECT_BASE_MS);
  teardown();
});

// --- A drop during the stability window does NOT reset the backoff ----------

test('a drop within WS_STABLE_MS leaves the backoff growing', () => {
  const teardown = subscribeWs('/ws/tasks', () => {});

  // First unstable cycle: delay 250, attempt advances to 1.
  let ws = latestSocket();
  ws.serverAccept();
  ws.serverDrop();
  assert.equal(pendingReconnect().delay, 250);
  fireAll();

  // Second connection opens (arming the stability timer) but drops before the
  // window elapses — the stability timer must have been cleared, so the next
  // delay reflects attempt=1, not a reset.
  ws = latestSocket();
  ws.serverAccept();
  ws.serverDrop();
  assert.equal(pendingReconnect().delay, 500);

  teardown();
});

// --- Teardown stops reconnecting and clears pending timers ------------------

test('teardown after a drop cancels the pending reconnect', () => {
  const teardown = subscribeWs('/ws/tasks', () => {});
  const ws = latestSocket();
  ws.serverAccept();
  ws.serverDrop();
  assert.equal(scheduled.length, 1); // reconnect pending
  teardown();
  assert.equal(scheduled.length, 0); // ...and cancelled
});
