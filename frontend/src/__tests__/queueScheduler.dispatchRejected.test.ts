import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceQueue } from '../components/workflows/queueScheduler.ts';
import { queued, queueState, scenario, started } from './queueScheduler.fixture.ts';

// ---------- dispatchRejected: backend 409 "slot busy" → requeue ----------
// The frontend sequential gate reads only the client's `activeRuns` snapshot,
// so a run that's started server-side but not yet in `activeRuns` counts as
// free — and the queue can dispatch the next entry alongside it. The backend
// now 409s that second start; the queue turns the 409 into `dispatchRejected`,
// which must put the entry back on the queue (NOT drop it like dispatchFailed)
// so it retries when the active run frees the slot.

test('dispatchRejected moves an in-flight entry back to the FRONT of the queue', () => {
  const state = queueState({
    running: true,
    queued: [queued('q2', 'wf2')],
    started: [started('q1', 'wf1', null)], // in-flight, runId not yet attached
  });

  const next = reduceQueue(state, { type: 'dispatchRejected', entryId: 'q1' });

  assert.deepEqual(next.started, [], 'the rejected entry leaves started');
  assert.deepEqual(
    next.queued.map((e) => e.id),
    ['q1', 'q2'],
    'the rejected entry is requeued ahead of later entries (FIFO retry)',
  );
  assert.equal(next.running, true, 'the queue stays running so it can retry');
  assert.deepEqual(next.deferredRetry, { entryId: 'q1' });
});

test('dispatchRejected preserves the entry override so the retry uses the same harness/model', () => {
  const state = queueState({
    running: true,
    started: [{ ...started('q1', 'wf1', null), harnessOverride: 'pi', piModelOverride: 'vllm/gpt' }],
  });

  const next = reduceQueue(state, { type: 'dispatchRejected', entryId: 'q1' });

  assert.deepEqual(next.queued, [
    { id: 'q1', workflowId: 'wf1', harnessOverride: 'pi', piModelOverride: 'vllm/gpt' },
  ]);
});

test('dispatchRejected for an unknown/attached entry is a no-op', () => {
  const state = queueState({
    running: true,
    started: [started('q1', 'wf1', 'run-1')], // already attached — not in-flight
  });
  assert.equal(reduceQueue(state, { type: 'dispatchRejected', entryId: 'q1' }), state);
  assert.equal(reduceQueue(state, { type: 'dispatchRejected', entryId: 'nope' }), state);
});

// End-to-end через the scheduler: the requeued entry waits behind the still-
// active external run, then dispatches once that run finishes — never two at
// once.
test('after the retry delay, a rejected entry still waits for the active run', () => {
  // Queue running with one entry dispatched (in-flight) while a manual run is
  // active server-side.
  const q = scenario(
    queueState({
      running: true,
      started: [started('q1', 'wf1', null)],
    }),
  ).externalActive(1); // the run that caused the 409 is now visible in activeRuns

  // 409 comes back → requeue. The subsequent step must NOT re-dispatch it,
  // because the external run still occupies the single sequential slot.
  q.dispatchRejected('q1');
  assert.deepEqual(q.startIds(), [], 'the requeued entry waits behind the active run');
  assert.deepEqual(q.queuedIds(), ['q1'], 'it sits at the head of the queue');
  assert.equal(q.state.running, true);

  q.step({ type: 'retryReady', entryId: 'q1' });
  assert.equal(q.state.deferredRetry, null);
  assert.deepEqual(q.startIds(), [], 'delay expiry does not bypass an occupied slot');

  // The active run finishes and leaves activeRuns.
  q.externalActive(0).runFinished('manual-run');
  assert.deepEqual(q.startIds(), ['q1'], 'q1 dispatches once the slot frees');
  assert.deepEqual(q.state.started, [started('q1', 'wf1', null)]);
});

test('a rejected entry defers even when the active-run snapshot looks empty', () => {
  // Empty activeRuns cannot distinguish a free slot from a stale socket view.
  const q = scenario(
    queueState({
      running: true,
      started: [started('q1', 'wf1', null)],
    }),
  ).externalActive(0);

  q.dispatchRejected('q1');
  assert.deepEqual(q.startIds(), [], 'no retry at HTTP round-trip speed');
  assert.deepEqual(q.queuedIds(), ['q1']);
  q.runFinished('manual-run');
  assert.deepEqual(q.startIds(), [], 'lifecycle events do not shorten the retry delay');
  q.step({ type: 'retryReady', entryId: 'other' });
  assert.deepEqual(q.startIds(), [], 'another entry cannot release the retry');
  q.step({ type: 'retryReady', entryId: 'q1' });
  assert.deepEqual(q.startIds(), ['q1'], 'retry eventually proceeds without a socket event');
  q.step({ type: 'retryReady', entryId: 'q1' });
  assert.deepEqual(q.startIds(), [], 'duplicate retry cannot dispatch a second request');
});

test('Stop clears a deferred retry and late busy responses leave the queue stopped', () => {
  const q = scenario().enqueue('q1', 'wf1').enqueue('q2', 'wf2').startQueue();
  q.dispatchRejected('q1').stopQueue();
  assert.equal(q.state.deferredRetry, null);
  q.step({ type: 'retryReady', entryId: 'q1' });
  assert.deepEqual(q.startIds(), []);
  assert.deepEqual(q.queuedIds(), ['q1', 'q2']);

  q.startQueue().stopQueue().dispatchRejected('q1');
  assert.equal(q.state.running, false);
  assert.equal(q.state.deferredRetry, null);
  assert.deepEqual(q.startIds(), []);
  assert.deepEqual(q.queuedIds(), ['q1', 'q2']);
});

test('removing or clearing deferred entries cancels their admission block', () => {
  const q = scenario().enqueue('q1', 'wf1').enqueue('q2', 'wf2').startQueue();
  q.dispatchRejected('q1').step({ type: 'removeFromQueue', entryId: 'q1' });
  assert.equal(q.state.deferredRetry, null);
  assert.deepEqual(q.startIds(), ['q2']);
  q.dispatchRejected('q2').step({ type: 'clearQueue' });
  assert.equal(q.state.deferredRetry, null);
  assert.equal(q.state.running, false);
  q.step({ type: 'retryReady', entryId: 'q2' });
  assert.deepEqual(q.startIds(), []);
});
