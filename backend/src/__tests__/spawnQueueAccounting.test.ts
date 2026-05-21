import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpawnAccounting } from '../spawnQueue/accounting.js';

// SpawnAccounting(softCap, priorityReserve) — batch is gated at softCap,
// priority/interactive at softCap + priorityReserve.

test('does not admit before the first successful poll', () => {
  const a = new SpawnAccounting(3, 2);
  assert.equal(a.isPollHealthy(), false);
  assert.equal(a.canAdmit('batch'), false);
  assert.equal(a.canAdmit('priority'), false);
});

test('reconcile primes the count and unlocks admission', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(1, Date.now());
  assert.equal(a.isPollHealthy(), true);
  assert.equal(a.getLiveCount(), 1);
  assert.equal(a.effectiveLive(), 1);
  assert.equal(a.headroom('batch'), 2); // 3 - 1
  assert.equal(a.canAdmit('batch'), true);
});

test('reservations count toward effectiveLive', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(0, Date.now());
  a.reserve(Date.now());
  a.reserve(Date.now());
  assert.equal(a.effectiveLive(), 2);
  assert.equal(a.reservedCount(), 2);
  assert.equal(a.headroom('batch'), 1);
});

test('batch is gated at softCap; priority/interactive get the reserve', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(3, Date.now()); // batch cap full
  assert.equal(a.canAdmit('batch'), false);
  assert.equal(a.headroom('batch'), 0);
  assert.equal(a.headroom('priority'), 2); // (3 + 2) - 3
  assert.equal(a.canAdmit('priority'), true);
  assert.equal(a.canAdmit('interactive'), true);
});

test('release frees a reserved slot', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(0, Date.now());
  const id = a.reserve(Date.now());
  assert.equal(a.effectiveLive(), 1);
  a.release(id);
  assert.equal(a.effectiveLive(), 0);
  assert.equal(a.reservedCount(), 0);
});

test('reconcile drops a reservation that spawned before the poll request', () => {
  const a = new SpawnAccounting(5, 2);
  a.reconcile(0, 1000);
  const id = a.reserve(1100);
  a.markSpawned(id, 1200); // resolved at 1200
  assert.equal(a.effectiveLive(), 1); // liveCount 0 + 1 reserved
  // Poll requested at 1300 (> 1200): its count already includes the session,
  // so the reservation must be dropped — not double-counted.
  a.reconcile(1, 1300);
  assert.equal(a.getLiveCount(), 1);
  assert.equal(a.reservedCount(), 0);
  assert.equal(a.effectiveLive(), 1);
});

test('reconcile keeps a still-spawning reservation', () => {
  const a = new SpawnAccounting(5, 2);
  a.reconcile(0, 1000);
  a.reserve(1100); // proxyCreateSession not back yet → status 'spawning'
  a.reconcile(0, 1300);
  assert.equal(a.reservedCount(), 1);
  assert.equal(a.effectiveLive(), 1);
});

test('reconcile keeps a reservation that spawned after the poll request', () => {
  const a = new SpawnAccounting(5, 2);
  a.reconcile(0, 1000);
  const id = a.reserve(1100);
  a.markSpawned(id, 1250); // resolved after the poll was requested
  a.reconcile(0, 1200); // the count could not have seen it yet
  assert.equal(a.reservedCount(), 1); // kept → the session is not lost
  assert.equal(a.effectiveLive(), 1);
});

test('a poll failure freezes admissions but keeps the last count', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(1, Date.now());
  assert.equal(a.canAdmit('batch'), true);
  a.notePollFailure();
  assert.equal(a.isPollHealthy(), false);
  assert.equal(a.canAdmit('batch'), false);
  assert.equal(a.getLiveCount(), 1); // last known count retained
  a.reconcile(1, Date.now()); // a later success unfreezes
  assert.equal(a.canAdmit('batch'), true);
});

test('an over-admit (hard-cap CAP) freezes admissions until the next poll', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(0, Date.now());
  assert.equal(a.canAdmit('batch'), true);
  a.noteOverAdmit();
  assert.equal(a.canAdmit('batch'), false);
  a.reconcile(2, Date.now()); // next poll corrects the count and unfreezes
  assert.equal(a.canAdmit('batch'), true);
});

test('headroom can go negative without admitting', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(5, Date.now()); // already over the batch cap
  assert.equal(a.headroom('batch'), -2);
  assert.equal(a.canAdmit('batch'), false);
  assert.equal(a.canAdmit('priority'), false); // (3 + 2) - 5 = 0
});

test('a negative polled count is clamped to zero', () => {
  const a = new SpawnAccounting(3, 2);
  a.reconcile(-1, Date.now());
  assert.equal(a.getLiveCount(), 0);
});
