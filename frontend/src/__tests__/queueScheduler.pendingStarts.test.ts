import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialQueueState,
  pendingStarts,
  shouldAutoStop,
} from '../components/workflows/queueScheduler.ts';
import { entryIds, queued, queueState, started } from './queueScheduler.fixture.ts';

// The pure scheduler queries: pendingStarts (which entries are eligible to
// dispatch right now) and shouldAutoStop (is the queue fully drained). The
// external-active-run gating of pendingStarts is exercised in
// queueScheduler.externalActive.test.ts.

// ---------- pendingStarts: the heart of the scheduler ----------

test('pendingStarts is empty when not running', () => {
  assert.deepEqual(
    pendingStarts(queueState({ queued: [queued('q1', 'wf1')] })),
    [],
  );
});

test('pendingStarts returns just the head of the queue, even with duplicates', () => {
  const state = queueState({
    queued: [queued('q1', 'wf1'), queued('q2', 'wf1'), queued('q3', 'wf2')],
    running: true,
  });

  assert.deepEqual(entryIds(pendingStarts(state)), ['q1']);
});

test('pendingStarts waits while something is in flight or active', () => {
  const inFlight = queueState({
    queued: [queued('q2', 'wf2')],
    running: true,
    started: [started('q1', 'wf1', null)],
  });
  assert.deepEqual(pendingStarts(inFlight), []);

  const active = queueState({
    ...inFlight,
    started: [started('q1', 'wf1', 'run1')],
  });
  assert.deepEqual(pendingStarts(active), []);
});

// ---------- shouldAutoStop ----------

test('shouldAutoStop returns false while items remain or a run is in flight', () => {
  assert.equal(shouldAutoStop(initialQueueState), false);
  assert.equal(
    shouldAutoStop(queueState({ queued: [queued('q1', 'wf1')], running: true })),
    false,
  );
  assert.equal(
    shouldAutoStop(queueState({ running: true, started: [started('q1', 'wf1', 'run1')] })),
    false,
  );
  assert.equal(shouldAutoStop(queueState({ running: true })), true);
});
