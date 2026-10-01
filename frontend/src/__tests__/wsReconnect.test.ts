import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeWs,
  subscribeWsShared,
  wsReconnectDelay,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_CAP_MS,
  WS_STABLE_MS,
} from '../api/ws.ts';
import {
  FakeWebSocket,
  installFakeWebSocket,
  installManualTimers,
  installWindow,
  type ManualTimers,
  type ScheduledTimer,
} from './domDoubles.ts';

// --- Fakes -----------------------------------------------------------------
//
// subscribeWs reaches for three globals — `WebSocket`, `window`, and the timer
// functions. The shared doubles stub all three so the reconnect lifecycle can
// be driven by hand and the scheduled backoff delays inspected. A manual timer
// queue (rather than node:test mock timers) keeps the scheduled delay values
// directly assertable.

let timers: ManualTimers;
let restoreWs: () => void;
let restoreWindow: () => void;
let unsubscribe: (() => void)[];

function trackSubscription(stop: () => void): () => void {
  unsubscribe.push(stop);
  return stop;
}

/** The socket created by the most recent connect(). */
function latestSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'expected a WebSocket to have been created');
  return ws;
}

/** The single timer pending while we wait to reconnect. */
function pendingReconnect(): ScheduledTimer {
  assert.equal(
    timers.scheduled.length,
    1,
    `expected exactly one pending reconnect timer, saw ${timers.scheduled.length}`,
  );
  return timers.scheduled[0];
}

beforeEach(() => {
  unsubscribe = [];
  timers = installManualTimers();
  restoreWs = installFakeWebSocket();
  restoreWindow = installWindow({
    location: { protocol: 'http:', host: 'localhost:5184' },
  });
});

afterEach(() => {
  // Release sockets, shared registrations and timers even when an assertion fails.
  for (const stop of unsubscribe.reverse()) stop();
  restoreWindow();
  restoreWs();
  timers.restore();
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
  const teardown = trackSubscription(subscribeWs('/ws/tasks', () => {}));
  const delays: number[] = [];

  // Six rounds of: server accepts the upgrade, then drops it before it can
  // become stable. The stability timer (armed in onopen) must be cleared by
  // the close, so the attempt counter is NEVER reset and the delay must grow.
  for (let i = 0; i < 6; i++) {
    const ws = latestSocket();
    ws.serverAccept(); // arms the WS_STABLE_MS stability timer
    ws.serverDrop(); // clears it, then schedules the reconnect
    delays.push(pendingReconnect().delay);
    timers.fireAll(); // reconnect -> connect() creates the next socket
  }

  // Strictly the documented exponential curve — not a flat 250ms loop, which
  // is exactly what the pre-fix `attempt = 0` on every onopen produced.
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 5000]);
  teardown();
});

// --- A genuinely healthy connection still resets the backoff ----------------

test('a connection that stays open past WS_STABLE_MS resets the backoff', () => {
  const teardown = trackSubscription(subscribeWs('/ws/tasks', () => {}));

  // Drive the backoff up with a few unstable cycles.
  for (let i = 0; i < 3; i++) {
    const ws = latestSocket();
    ws.serverAccept();
    ws.serverDrop();
    timers.fireAll();
  }

  // This connection proves stable: open, then let the stability timer fire.
  const ws = latestSocket();
  ws.serverAccept();
  const stable = pendingReconnect(); // the only pending timer is the stability one
  assert.equal(stable.delay, WS_STABLE_MS);
  timers.fireAll(); // stability window elapses -> attempt reset to 0

  // A subsequent drop now backs off from the base delay again.
  ws.serverDrop();
  assert.equal(pendingReconnect().delay, WS_RECONNECT_BASE_MS);
  teardown();
});

// --- A drop during the stability window does NOT reset the backoff ----------

test('a drop within WS_STABLE_MS leaves the backoff growing', () => {
  const teardown = trackSubscription(subscribeWs('/ws/tasks', () => {}));

  // First unstable cycle: delay 250, attempt advances to 1.
  let ws = latestSocket();
  ws.serverAccept();
  ws.serverDrop();
  assert.equal(pendingReconnect().delay, 250);
  timers.fireAll();

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
  const teardown = trackSubscription(subscribeWs('/ws/tasks', () => {}));
  const ws = latestSocket();
  ws.serverAccept();
  ws.serverDrop();
  assert.equal(timers.scheduled.length, 1); // reconnect pending
  teardown();
  assert.equal(timers.scheduled.length, 0); // ...and cancelled
});

test('teardown ignores queued socket callbacks without restoring timers or delivering messages', () => {
  const received: unknown[] = [];
  let disconnects = 0;
  const teardown = trackSubscription(subscribeWs('/cancelled', (msg) => received.push(msg), () => { disconnects += 1; }));
  const ws = latestSocket();
  teardown();
  ws.serverAccept();
  ws.onmessage?.({ data: '{"stale":true}' });
  ws.serverDrop();
  assert.deepEqual(received, []);
  assert.equal(disconnects, 0);
  assert.equal(timers.scheduled.length, 0);
});

test('a throwing message handler is reported and does not close the socket', () => {
  const reported: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { reported.push(args); };
  let teardown: (() => void) | undefined;
  try {
    const received: unknown[] = [];
    teardown = trackSubscription(subscribeWs<{ n: number }>('/ws/throwing', (msg) => {
      received.push(msg);
      if (msg.n === 1) throw new Error('consumer failed');
    }));
    const ws = latestSocket();
    ws.serverAccept();
    ws.onmessage?.({ data: '{"n":1}' });
    ws.onmessage?.({ data: '{"n":2}' });
    assert.deepEqual(received, [{ n: 1 }, { n: 2 }], 'the frame after the throw is still delivered');
    assert.equal(reported.length, 1, 'the throw is reported once');
    assert.equal(reported[0][0], '[ws] handler failed');
    assert.equal(reported[0][1], '/ws/throwing');
    assert.equal(ws.closed, false, 'the socket stays open');
    // Only the stability timer is pending — no reconnect was scheduled.
    assert.equal(pendingReconnect().delay, WS_STABLE_MS);
    // A malformed frame is still dropped silently, not reported as a handler failure.
    ws.onmessage?.({ data: 'not json' });
    assert.equal(received.length, 2);
    assert.equal(reported.length, 1);
  } finally {
    teardown?.();
    console.error = origError;
  }
});

test('a throwing disconnect callback cannot stop reconnecting', () => {
  const teardown = trackSubscription(subscribeWs('/disconnect-error', () => {}, () => { throw new Error('subscriber failed'); }));
  latestSocket().serverDrop();
  assert.equal(pendingReconnect().delay, WS_RECONNECT_BASE_MS);
  teardown();
});

// --- Shared channel replay and registration lifetimes ----------------------

test('ordinary shared feeds retain their existing cached snapshot across disconnects', () => {
  const replay = (_value: unknown) => true;
  trackSubscription(subscribeWsShared('/ordinary-snapshot', () => {}, replay));
  const original = latestSocket();
  original.serverAccept();
  original.onmessage?.({ data: JSON.stringify({ tasks: ['task-1'] }) });
  original.serverDrop();
  const late: unknown[] = [];
  trackSubscription(subscribeWsShared('/ordinary-snapshot', (value) => late.push(value), replay));
  assert.deepEqual(late, [{ tasks: ['task-1'] }]);
});

for (const finalState of ['open', 'dropped'] as const) {
  test(`identical callbacks have independent shared subscription lifetimes (${finalState} at final unsubscribe)`, () => {
    const path = '/ws/tasks?project=%2Fshared-lifetime';
    const oldSnapshot = { type: 'tasks', tasks: [{ id: 'task-1', projectPath: '/shared-lifetime', status: 'in_progress' }] };
    const newSnapshot = { type: 'tasks', tasks: [{ id: 'task-2', projectPath: '/shared-lifetime', status: 'open' }] };
    const replay = (msg: typeof oldSnapshot) => msg.type === 'tasks';
    const updates: unknown[] = [];
    let disconnects = 0;
    const onMessage = (value: unknown) => updates.push(value);
    const onDisconnect = () => { disconnects += 1; };
    const first = trackSubscription(subscribeWsShared(path, onMessage, replay, { onDisconnect }));
    const second = trackSubscription(subscribeWsShared(path, onMessage, replay, { onDisconnect }));
    const original = latestSocket();
    original.serverAccept();
    original.onmessage?.({ data: JSON.stringify(oldSnapshot) });
    assert.equal(FakeWebSocket.instances.length, 1, 'both owners share one socket');
    assert.deepEqual(updates, [oldSnapshot, oldSnapshot], 'identical callbacks each own a registration');

    first();
    assert.equal(original.closed, false, 'the second registration still owns the socket');
    original.onmessage?.({ data: '{"value":1}' });
    assert.deepEqual(updates, [oldSnapshot, oldSnapshot, { value: 1 }]);
    original.serverDrop();
    assert.equal(disconnects, 1, 'the remaining registration keeps its shared disconnect callback');
    if (finalState === 'open') {
      timers.fireAll();
      latestSocket().serverAccept();
    }
    const survivingSocket = latestSocket();
    const socketCount = FakeWebSocket.instances.length;
    const survivingReplay: unknown[] = [];
    const stopProbe = trackSubscription(subscribeWsShared(path, (msg) => survivingReplay.push(msg), replay));
    assert.deepEqual(survivingReplay, [oldSnapshot], 'replay survives while the second owner remains');
    assert.equal(FakeWebSocket.instances.length, socketCount, 'a surviving owner keeps the same channel');
    stopProbe();
    assert.equal(pendingReconnect().delay, finalState === 'open' ? WS_STABLE_MS : WS_RECONNECT_BASE_MS);

    second();
    assert.equal(timers.scheduled.length, 0, 'final unsubscribe cancels stability and reconnect timers');
    if (finalState === 'open') assert.equal(survivingSocket.closed, true);
    timers.fireAll();
    assert.equal(FakeWebSocket.instances.length, socketCount, 'ownerless timers cannot recreate a socket');

    trackSubscription(subscribeWsShared(path, onMessage, replay, { onDisconnect }));
    const replacement = latestSocket();
    assert.notEqual(replacement, survivingSocket, 'the exact same path creates a fresh channel');
    assert.equal(FakeWebSocket.instances.length, socketCount + 1);
    assert.deepEqual(updates, [oldSnapshot, oldSnapshot, { value: 1 }], 'reopening cannot replay the old snapshot');
    second();
    first();
    assert.equal(replacement.closed, false, 'old cleanup cannot close a replacement channel');
    replacement.serverAccept();
    replacement.onmessage?.({ data: '{"value":2}' });
    assert.deepEqual(updates, [oldSnapshot, oldSnapshot, { value: 1 }, { value: 2 }]);
    replacement.onmessage?.({ data: JSON.stringify(newSnapshot) });
    assert.deepEqual(updates, [oldSnapshot, oldSnapshot, { value: 1 }, { value: 2 }, newSnapshot],
      'only the current registration receives the new snapshot');

    first();
    second();
    const late: unknown[] = [];
    trackSubscription(subscribeWsShared(path, (msg) => late.push(msg), replay));
    assert.deepEqual(late, [newSnapshot], 'old cleanup cannot erase the replacement replay');
    assert.equal(latestSocket(), replacement);
    assert.equal(replacement.closed, false);
  });
}

test('throwing shared message and replay subscribers cannot block peers or leak registrations', () => {
  const replay = (_value: unknown) => true;
  const broken = trackSubscription(subscribeWsShared('/throwing-subscriber', () => { throw new Error('broken handler'); }, replay));
  const received: unknown[] = [];
  const healthy = trackSubscription(subscribeWsShared('/throwing-subscriber', (msg) => received.push(msg), replay));
  const current = latestSocket();
  current.onmessage?.({ data: '{"value":1}' });
  assert.deepEqual(received, [{ value: 1 }]);

  let late: (() => void) | undefined;
  assert.doesNotThrow(() => {
    late = trackSubscription(subscribeWsShared('/throwing-subscriber', () => { throw new Error('broken replay'); }, replay));
  });
  assert.ok(late, 'a replay failure still returns its registration cleanup');
  late();
  broken();
  assert.equal(current.closed, false);
  healthy();
  assert.equal(current.closed, true, 'all registrations can be released despite callback errors');
});
