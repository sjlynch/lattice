import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSweepScheduler } from '../piModels/sweepScheduler.js';

// A sweep whose completion the test controls, so overlapping callers can be
// arranged deterministically instead of raced against real timing.
function deferredSweep() {
  const resolvers: Array<(changed: boolean) => void> = [];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    sweep: () => {
      calls += 1;
      return new Promise<boolean>((resolve) => resolvers.push(resolve));
    },
    // Settle the Nth sweep (0-based) and let microtasks drain.
    finish: async (index: number, changed = true) => {
      resolvers[index]?.(changed);
      await new Promise((r) => setImmediate(r));
    },
  };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('a second caller joins the in-flight sweep instead of starting another', async () => {
  const d = deferredSweep();
  const s = createSweepScheduler({ sweep: d.sweep, ttlMs: 1000, now: clock().now });
  const a = s.run();
  const b = s.run();
  assert.equal(d.calls, 1, 'one sweep for two callers');
  await d.finish(0, true);
  assert.deepEqual([await a, await b], [true, true], 'both see the same result');
});

test('the TTL throttles a later caller, and expires', async () => {
  const d = deferredSweep();
  const c = clock();
  const s = createSweepScheduler({ sweep: d.sweep, ttlMs: 1000, now: c.now });

  const first = s.run();
  await d.finish(0);
  assert.equal(await first, true);

  // Inside the window → no new sweep.
  assert.equal(await s.run(), false);
  assert.equal(d.calls, 1);

  // Past the window → sweeps again.
  c.advance(1001);
  const third = s.run();
  assert.equal(d.calls, 2);
  await d.finish(1);
  assert.equal(await third, true);
});

// The bug this pins: a caller inside the TTL window that is handed `false`
// while a sweep is mid-write reads state the sweep is about to replace.
test('an in-flight sweep is joined even inside the TTL window', async () => {
  const d = deferredSweep();
  const c = clock();
  const s = createSweepScheduler({ sweep: d.sweep, ttlMs: 1000, now: c.now });
  const first = s.run();
  await d.finish(0);
  await first;

  c.advance(1001);
  const running = s.run(); // starts sweep #2
  assert.equal(d.calls, 2);
  // A caller arriving now is inside the TTL of sweep #1 but sweep #2 is live.
  const joiner = s.run();
  assert.equal(d.calls, 2, 'joined rather than throttled-to-false');
  await d.finish(1, true);
  assert.deepEqual([await running, await joiner], [true, true]);
});

// The bug this pins: the forcing caller has just changed the INPUTS (a settings
// save added an endpoint). A sweep already running read them BEFORE that
// change, so adopting its result drops the new endpoint until the TTL expires —
// the "I added an endpoint and see no models" failure.
test('force never adopts a sweep that started before it', async () => {
  const d = deferredSweep();
  const s = createSweepScheduler({ sweep: d.sweep, ttlMs: 60_000, now: clock().now });

  const stale = s.run(); // sweep #1, reading pre-change state
  assert.equal(d.calls, 1);

  const forced = s.run({ force: true });
  // Still only one: force waits the stale sweep out rather than joining it.
  assert.equal(d.calls, 1);

  await d.finish(0, false);
  assert.equal(await stale, false);
  await new Promise((r) => setImmediate(r));

  // Now the forced sweep runs — a SECOND call, reading post-change state.
  assert.equal(d.calls, 2, 'force started its own sweep');
  await d.finish(1, true);
  assert.equal(await forced, true);
});

test('force ignores the TTL entirely', async () => {
  const d = deferredSweep();
  const c = clock();
  const s = createSweepScheduler({ sweep: d.sweep, ttlMs: 60_000, now: c.now });
  const first = s.run();
  await d.finish(0);
  await first;

  const forced = s.run({ force: true }); // well inside the TTL
  assert.equal(d.calls, 2);
  await d.finish(1);
  assert.equal(await forced, true);
});

// maxWaitMs bounds the WAIT, not the WORK: an HTTP handler must not sit behind
// a probe serving out its timeout against a host that is down.
test('maxWaitMs gives up waiting without cancelling the sweep', async () => {
  const d = deferredSweep();
  const s = createSweepScheduler({ sweep: d.sweep, ttlMs: 60_000, now: clock().now });

  assert.equal(await s.run({ maxWaitMs: 10 }), false, 'returns the neutral answer');
  assert.equal(s.isRunning(), true, 'the sweep is still going');

  // And when it lands, the next caller sees its result rather than re-probing.
  await d.finish(0, true);
  assert.equal(s.isRunning(), false);
  assert.equal(d.calls, 1, 'no duplicate sweep was started');
});

test('a rejecting sweep is reported, resolves false, and does not wedge the scheduler', async () => {
  let reported: unknown;
  let calls = 0;
  const c = clock();
  const s = createSweepScheduler({
    sweep: async () => {
      calls += 1;
      if (calls === 1) throw new Error('endpoint exploded');
      return true;
    },
    ttlMs: 1000,
    now: c.now,
    onError: (err) => (reported = err),
  });

  assert.equal(await s.run(), false);
  assert.equal((reported as Error).message, 'endpoint exploded');
  assert.equal(s.isRunning(), false, 'in-flight cleared despite the throw');

  // The next window still sweeps — a failure must not latch.
  c.advance(1001);
  assert.equal(await s.run(), true);
});
