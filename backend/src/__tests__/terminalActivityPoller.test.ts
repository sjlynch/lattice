import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalActivityPoller } from '../terminalActivityPoller.js';

type ProbeResult = string[] | null;
function deferred() {
  let resolve!: (value: ProbeResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ProbeResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(probe?: (isCurrent: () => boolean) => Promise<ProbeResult>) {
  let now = 0;
  let resets = 0;
  let calls = 0;
  let unrefs = 0;
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  const requests: ReturnType<typeof deferred>[] = [];
  const fences: Array<() => boolean> = [];
  const controller = createTerminalActivityPoller({
    now: () => now,
    reset: () => { resets++; },
    fetchBusy: (isCurrent) => {
      calls++;
      fences.push(isCurrent);
      if (probe) return probe(isCurrent);
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    setInterval: (callback, delay) => {
      assert.equal(delay, 1_000);
      const timer = { unref: () => { unrefs++; } } as ReturnType<typeof setInterval>;
      timers.set(timer, callback);
      return timer;
    },
    clearInterval: timer => { assert.equal(timers.delete(timer), true); },
  });
  return {
    ...controller, requests, fences, timers,
    get calls() { return calls; },
    get resets() { return resets; },
    get unrefs() { return unrefs; },
    async tick(at: number) {
      now = at;
      for (const callback of [...timers.values()]) callback();
      await settle();
    },
  };
}

test('one shared poll loop emits initial state and changed sets only', async () => {
  const poller = setup();
  const first: string[][] = [];
  const stopFirst = poller.subscribe(ids => first.push(ids));
  assert.deepEqual(first, [[]]);
  assert.equal(poller.calls, 1);
  assert.equal(poller.unrefs, 1);
  assert.equal(poller.resets, 1);
  poller.requests[0].resolve(['b', 'a', 'a']);
  await settle();
  assert.deepEqual(first, [[], ['a', 'b']]);

  const second: string[][] = [];
  const stopSecond = poller.subscribe(ids => second.push(ids));
  assert.deepEqual(second, [['a', 'b']]);
  assert.equal(poller.timers.size, 1);
  assert.equal(poller.calls, 1);
  await poller.tick(1_000);
  poller.requests[1].resolve(['a', 'b']);
  await settle();
  assert.equal(first.length, 2);
  assert.equal(second.length, 1);
  stopFirst();
  await poller.tick(2_000);
  poller.requests[2].resolve([]);
  await settle();
  assert.deepEqual(second, [['a', 'b'], []]);
  stopSecond();
  stopSecond();
  assert.equal(poller.timers.size, 0);
  assert.equal(poller.resets, 2);
});

test('late response cannot repopulate an ended generation or unlock its successor probe', async () => {
  const poller = setup();
  const stopOld = poller.subscribe(() => {});
  const queuedOldTick = [...poller.timers.values()][0];
  stopOld();
  assert.equal(poller.fences[0](), false);
  const seen: string[][] = [];
  const stopNew = poller.subscribe(ids => seen.push(ids));
  assert.equal(poller.fences[1](), true);
  poller.requests[0].resolve(['finished-old-agent']);
  await settle();
  queuedOldTick();
  await poller.tick(1_000);
  assert.equal(poller.calls, 2, 'new generation already has one pending probe');
  assert.deepEqual(seen, [[]]);
  poller.requests[1].resolve(['new-agent']);
  await settle();
  assert.deepEqual(seen, [[], ['new-agent']]);
  stopNew();
  assert.equal(poller.timers.size, 0);
});

test('late rejected probe is contained after the last unsubscribe', async () => {
  const poller = setup();
  const seen: string[][] = [];
  const stop = poller.subscribe(ids => seen.push(ids));
  stop();
  poller.requests[0].reject(new Error('transport failed after disconnect'));
  await settle();
  await poller.tick(10_000);
  assert.deepEqual(seen, [[]]);
  assert.equal(poller.calls, 1);
  assert.equal(poller.timers.size, 0);
});

test('unknown probes retain busy briefly then expire it, and healthy probes restore it', async () => {
  const poller = setup();
  const seen: string[][] = [];
  const stop = poller.subscribe(ids => seen.push(ids));
  poller.requests[0].resolve(['agent']);
  await settle();
  for (let tick = 1; tick <= 5; tick++) {
    await poller.tick(tick * 1_000);
    poller.requests[tick].resolve(null);
    await settle();
    assert.equal(seen.length, tick < 5 ? 2 : 3);
  }
  assert.deepEqual(seen, [[], ['agent'], []]);
  await poller.tick(6_000);
  poller.requests[6].resolve(['agent']);
  await settle();
  assert.deepEqual(seen, [[], ['agent'], [], ['agent']]);
  stop();
});

test('a hung probe cannot keep stale busy display or cause overlapping requests', async () => {
  const poller = setup();
  const seen: string[][] = [];
  const stop = poller.subscribe(ids => seen.push(ids));
  poller.requests[0].resolve(['agent']);
  await settle();
  for (let at = 1_000; at <= 12_000; at += 1_000) await poller.tick(at);
  assert.equal(poller.calls, 2);
  assert.deepEqual(seen, [[], ['agent'], []]);
  stop();
  assert.equal(poller.timers.size, 0);
  poller.requests[1].resolve(['obsolete']);
  await settle();
  assert.deepEqual(seen, [[], ['agent'], []]);
});

test('successful unchanged busy snapshots refresh the stale grace deadline', async () => {
  const poller = setup();
  const seen: string[][] = [];
  const stop = poller.subscribe(ids => seen.push(ids));
  poller.requests[0].resolve(['agent']);
  await settle();
  await poller.tick(4_000);
  poller.requests[1].resolve(['agent']);
  await settle();
  await poller.tick(5_000);
  poller.requests[2].resolve(null);
  await settle();
  await poller.tick(8_999);
  assert.deepEqual(seen, [[], ['agent']]);
  await poller.tick(9_000);
  assert.deepEqual(seen, [[], ['agent'], []]);
  stop();
});

test('synchronous and asynchronous probe failures do not stop future polls', async () => {
  let call = 0;
  const poller = setup(() => {
    call++;
    if (call === 1) return Promise.resolve(['agent']);
    if (call === 2) throw new Error('unexpected synchronous exception');
    return Promise.reject(new Error('rejected probe'));
  });
  const seen: string[][] = [];
  const stop = poller.subscribe(ids => seen.push(ids));
  await settle();
  for (let at = 1_000; at <= 6_000; at += 1_000) await poller.tick(at);
  assert.equal(poller.calls, 7);
  assert.deepEqual(seen, [[], ['agent'], []]);
  stop();
});

test('subscriber exceptions and payload mutations cannot break fanout or cache', async () => {
  const poller = setup();
  const stopBroken = poller.subscribe(ids => {
    ids.push('injected');
    throw new Error('subscriber failed');
  });
  const seen: string[][] = [];
  const stopHealthy = poller.subscribe(ids => seen.push(ids));
  poller.requests[0].resolve(['agent']);
  await settle();
  assert.deepEqual(seen, [[], ['agent']]);
  const replay: string[][] = [];
  const stopReplay = poller.subscribe(ids => replay.push(ids));
  assert.deepEqual(replay, [['agent']]);
  stopBroken();
  stopHealthy();
  stopReplay();
  assert.equal(poller.timers.size, 0);
});

test('independent subscriptions of the same callback have independent lifetimes', async () => {
  const poller = setup();
  const seen: string[][] = [];
  const listener = (ids: string[]) => { seen.push(ids); };
  const stopFirst = poller.subscribe(listener);
  const stopSecond = poller.subscribe(listener);
  stopFirst();
  assert.equal(poller.timers.size, 1);
  poller.requests[0].resolve(['agent']);
  await settle();
  assert.deepEqual(seen, [[], [], ['agent']]);
  stopSecond();
  assert.equal(poller.timers.size, 0);
});

test('fanout skips a subscriber removed by an earlier listener', async () => {
  const poller = setup();
  let stopSecond = () => {};
  const stopFirst = poller.subscribe(ids => { if (ids.length) stopSecond(); });
  const seen: string[][] = [];
  stopSecond = poller.subscribe(ids => seen.push(ids));
  poller.requests[0].resolve(['agent']);
  await settle();
  assert.deepEqual(seen, [[]]);
  stopFirst();
  assert.equal(poller.timers.size, 0);
});
