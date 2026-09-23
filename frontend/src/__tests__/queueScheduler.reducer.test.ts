import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialQueueState,
  reduceQueue,
} from '../components/workflows/queueScheduler.ts';
import { entryIds, queued, queueState, scenario, started } from './queueScheduler.fixture.ts';

// Pure reducer semantics: enqueue / removeFromQueue / clearQueue, the
// start/stop toggles, and the runId-keyed runFinished bookkeeping. The
// dispatch side-effects of these actions live in queueScheduler.step.test.ts.

// ---------- enqueue / removeFromQueue / clearQueue ----------

test('enqueue appends independent entries in FIFO order', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .enqueue('q3', 'wf3');

  assert.deepEqual(q.queuedIds(), ['q1', 'q2', 'q3']);
});

test('enqueue allows the same workflow more than once with separate overrides', () => {
  const q = scenario()
    .enqueue('q1', 'wf1', 'claude')
    .enqueue('q2', 'wf1', 'pi');

  assert.deepEqual(
    q.state.queued.map((entry) => ({
      workflowId: entry.workflowId,
      harnessOverride: entry.harnessOverride,
    })),
    [
      { workflowId: 'wf1', harnessOverride: 'claude' },
      { workflowId: 'wf1', harnessOverride: 'pi' },
    ],
  );
});

test('removeFromQueue drops only the matching queued entry id', () => {
  let state = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf1').state;

  state = reduceQueue(state, { type: 'removeFromQueue', entryId: 'q1' });
  assert.deepEqual(entryIds(state.queued), ['q2']);

  const before = state;
  state = reduceQueue(state, { type: 'removeFromQueue', entryId: 'nope' });
  assert.strictEqual(state, before);
});

test('clearQueue empties queued entries without affecting started runs', () => {
  const state = reduceQueue(
    queueState({
      queued: [queued('q1', 'wf1'), queued('q2', 'wf2')],
      running: true,
      started: [started('q0', 'wf0', 'run0')],
    }),
    { type: 'clearQueue' },
  );

  assert.deepEqual(state.queued, []);
  assert.deepEqual(state.started, [started('q0', 'wf0', 'run0')]);
  assert.equal(state.running, true);
});

// ---------- start / stop ----------

test('startQueue refuses when there is nothing queued', () => {
  const state = reduceQueue(initialQueueState, { type: 'startQueue' });
  assert.equal(state.running, false);
});

test('startQueue flips running on with at least one queued item', () => {
  const state = reduceQueue(queueState({ queued: [queued('q1', 'wf1')] }), {
    type: 'startQueue',
  });

  assert.equal(state.running, true);
  assert.deepEqual(state.queued, [queued('q1', 'wf1')]);
});

test('stopQueue flips running off without disturbing the queue', () => {
  const state = reduceQueue(
    queueState({
      queued: [queued('q2', 'wf2')],
      running: true,
      started: [started('q1', 'wf1', 'run1')],
    }),
    { type: 'stopQueue' },
  );

  assert.equal(state.running, false);
  assert.deepEqual(state.queued, [queued('q2', 'wf2')]);
  assert.deepEqual(state.started, [started('q1', 'wf1', 'run1')]);
});

// ---------- runFinished bookkeeping (runId-keyed) ----------

test('runFinished matches by runId, not duplicate workflow id', () => {
  const state = reduceQueue(
    queueState({
      running: true,
      started: [started('q1', 'wf1', 'run1'), started('q2', 'wf1', 'run2')],
    }),
    { type: 'runFinished', runId: 'run2' },
  );

  assert.deepEqual(state.started, [started('q1', 'wf1', 'run1')]);
});

// A workflow that errored or was cancelled must NOT cascade into the next
// queued workflow — one bad run shouldn't drag the rest of the
// pipeline down with it. The user can re-trigger the queue after inspecting.
test('runFinished with errored status stops the queue', () => {
  const state = reduceQueue(
    queueState({
      queued: [queued('q2', 'wf2')],
      running: true,
      started: [started('q1', 'wf1', 'run1')],
    }),
    { type: 'runFinished', runId: 'run1', status: 'errored' },
  );

  assert.equal(state.running, false, 'queue stops on errored');
  assert.deepEqual(state.queued, [queued('q2', 'wf2')], 'remaining queued entries survive');
  assert.deepEqual(state.started, [], 'q1 cleared from started');
});

test('runFinished with cancelled status stops the queue', () => {
  const state = reduceQueue(
    queueState({
      queued: [queued('q2', 'wf2')],
      running: true,
      started: [started('q1', 'wf1', 'run1')],
    }),
    { type: 'runFinished', runId: 'run1', status: 'cancelled' },
  );

  assert.equal(state.running, false);
  assert.deepEqual(state.queued, [queued('q2', 'wf2')]);
});
