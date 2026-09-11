import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ScanCoordinator } from '../scanner/coordinator.js';
import { ScanCancelledError } from '../scanner/fileMetrics.js';
import type { ScanOptions } from '../scanner/scan.js';
import type { ScanResult } from '../scanner/graphAggregate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

const root = path.resolve('scan-coordinator-fixture');
const result: ScanResult = { root, nodes: [], links: [] };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('twenty concurrent same-project HTTP scans share one scan', async () => {
  const done = deferred<ScanResult>();
  let calls = 0;
  const coordinator = new ScanCoordinator(async () => { calls++; return done.promise; }, () => undefined);
  const requests = Array.from({ length: 20 }, (_, i) =>
    coordinator.request(i % 2 ? path.join(root, '.') : root));
  await tick();
  assert.equal(calls, 1);
  done.resolve(result);
  assert.deepEqual(await Promise.all(requests), Array(20).fill(result));
});

test('disconnecting one subscriber leaves the shared scan active for its survivor', async () => {
  const done = deferred<ScanResult>();
  let options: ScanOptions = {};
  const coordinator = new ScanCoordinator(async (_root, opts) => {
    options = opts ?? {};
    return done.promise;
  }, () => undefined);
  const controller = new AbortController();
  const abandoned = coordinator.request(root, controller.signal);
  const rejected = assert.rejects(abandoned, ScanCancelledError);
  const survivor = coordinator.request(root);
  await tick();
  controller.abort();
  await rejected;
  assert.equal(options.isCancelled?.(), false);
  done.resolve(result);
  assert.equal(await survivor, result);
});

test('all-disconnected work is cancelled and a new caller starts fresh immediately', async () => {
  const pending = [deferred<ScanResult>(), deferred<ScanResult>()];
  const options: ScanOptions[] = [];
  const coordinator = new ScanCoordinator(async (_root, opts) => {
    options.push(opts ?? {});
    return pending[options.length - 1].promise;
  }, () => undefined);
  const controller = new AbortController();
  const abandoned = coordinator.request(root, controller.signal);
  const rejected = assert.rejects(abandoned, ScanCancelledError);
  await tick();
  controller.abort();
  await rejected;
  assert.equal(options[0].isCancelled?.(), true);
  const fresh = coordinator.request(root);
  await tick();
  assert.equal(options.length, 2);
  assert.equal(options[1].isCancelled?.(), false);
  pending[0].reject(new ScanCancelledError());
  pending[1].resolve(result);
  assert.equal(await fresh, result);
});

test('failed shared scans do not poison future requests', async () => {
  let calls = 0;
  const coordinator = new ScanCoordinator(async () => {
    if (++calls === 1) throw new Error('temporary scan failure');
    return result;
  }, () => undefined);
  const requests = [coordinator.request(root), coordinator.request(root)];
  await Promise.all(requests.map((p) => assert.rejects(p, /temporary scan failure/)));
  assert.equal(await coordinator.request(root), result);
  assert.equal(calls, 2);
});

test('a newer watcher revision requests a fresh scan while older subscribers finish', async () => {
  let revision = 1;
  let calls = 0;
  const pending = [deferred<ScanResult>(), deferred<ScanResult>()];
  const coordinator = new ScanCoordinator(async () => pending[calls++].promise, () => revision);
  const old = coordinator.request(root);
  await tick();
  revision++;
  const fresh = coordinator.request(root);
  await tick();
  assert.equal(calls, 2);
  pending[0].resolve(result);
  assert.equal(await old, result);
  // The old completion must not evict the newer in-flight entry.
  const joined = coordinator.request(root);
  await tick();
  assert.equal(calls, 2);
  pending[1].resolve(result);
  assert.deepEqual(await Promise.all([fresh, joined]), [result, result]);
});

test('an already-aborted request never starts work', async () => {
  let calls = 0;
  const coordinator = new ScanCoordinator(async () => { calls++; return result; }, () => undefined);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(coordinator.request(root, controller.signal), ScanCancelledError);
  await tick();
  assert.equal(calls, 0);
});
