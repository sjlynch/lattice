import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryAcquire, release, isLocked } from '../mergeLocks.js';

test('tryAcquire returns a token for a fresh task and null while held', () => {
  const id = 't_test_acquire_' + Date.now();
  assert.equal(isLocked(id), false);
  const first = tryAcquire(id);
  assert.notEqual(first, null);
  assert.equal(isLocked(id), true);
  assert.equal(tryAcquire(id), null);
  assert.equal(release(first!), true);
  assert.equal(isLocked(id), false);
  const second = tryAcquire(id);
  assert.notEqual(second, null);
  assert.equal(release(second!), true);
});

test('locks are independent per task id', () => {
  const a = 't_test_a_' + Date.now();
  const b = 't_test_b_' + Date.now();
  const lockA1 = tryAcquire(a);
  const lockB = tryAcquire(b);
  assert.notEqual(lockA1, null);
  assert.notEqual(lockB, null);
  assert.equal(tryAcquire(a), null);
  assert.equal(release(lockA1!), true);
  const lockA2 = tryAcquire(a);
  assert.notEqual(lockA2, null);
  assert.equal(release(lockA2!), true);
  assert.equal(release(lockB!), true);
});

test('release of a stale or unheld token is a no-op', () => {
  const id = 't_test_release_unheld_' + Date.now();
  const lock = tryAcquire(id);
  assert.notEqual(lock, null);
  assert.equal(release(lock!), true);
  assert.equal(release(lock!), false);
  assert.equal(isLocked(id), false);
  const next = tryAcquire(id);
  assert.notEqual(next, null);
  assert.equal(release(lock!), false, 'stale token must not clear a new owner');
  assert.equal(isLocked(id), true);
  assert.equal(release(next!), true);
});
