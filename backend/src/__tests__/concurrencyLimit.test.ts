import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrencyLimiter } from '../concurrencyLimit.js';
import { WATCHER_ANALYSIS_CONCURRENCY } from '../health/watcher/fileAnalysis.js';

test('createConcurrencyLimiter caps in-flight bodies and drains FIFO', async () => {
  const limiter = createConcurrencyLimiter(3);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const release: Array<() => void> = [];
  const jobs = Array.from({ length: 10 }, (_, i) =>
    limiter.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(i);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return i;
    }),
  );
  // Let the first slots start.
  await new Promise((r) => setImmediate(r));
  assert.equal(limiter.active, 3);
  assert.equal(limiter.waiting, 7);
  assert.deepEqual(order, [0, 1, 2]);
  while (release.length > 0) {
    release.shift()!();
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(peak, 3, 'never more than `max` bodies at once');
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'FIFO admission');
  assert.equal(limiter.active, 0);
});

test('a throwing body releases its slot', async () => {
  const limiter = createConcurrencyLimiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limiter.run(async () => 'ok'), 'ok');
  assert.equal(limiter.active, 0);
});

test('the watcher analysis gate is small and bounded', () => {
  assert.ok(WATCHER_ANALYSIS_CONCURRENCY >= 2 && WATCHER_ANALYSIS_CONCURRENCY <= 16);
  assert.throws(() => createConcurrencyLimiter(0));
});
