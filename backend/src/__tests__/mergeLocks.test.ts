import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryAcquire, release, isLocked } from '../mergeLocks.js';

test('tryAcquire returns true for a fresh task and false while held', () => {
  const id = 't_test_acquire_' + Date.now();
  assert.equal(isLocked(id), false);
  assert.equal(tryAcquire(id), true);
  assert.equal(isLocked(id), true);
  assert.equal(tryAcquire(id), false);
  release(id);
  assert.equal(isLocked(id), false);
  assert.equal(tryAcquire(id), true);
  release(id);
});

test('locks are independent per task id', () => {
  const a = 't_test_a_' + Date.now();
  const b = 't_test_b_' + Date.now();
  assert.equal(tryAcquire(a), true);
  assert.equal(tryAcquire(b), true);
  assert.equal(tryAcquire(a), false);
  release(a);
  assert.equal(tryAcquire(a), true);
  release(a);
  release(b);
});

test('release of an unheld lock is a no-op', () => {
  const id = 't_test_release_unheld_' + Date.now();
  release(id);
  assert.equal(isLocked(id), false);
  assert.equal(tryAcquire(id), true);
  release(id);
});
