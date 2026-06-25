import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingStarts } from '../components/workflows/queueScheduler.ts';
import { entryIds, queued, queueState, scenario, started } from './queueScheduler.fixture.ts';

// ---------- enqueue-while-busy auto-start (external active run) ----------
// Queuing a workflow while another run is already in flight should behave as if
// the user pressed Start queue: the new entry auto-runs once the active run
// frees the slot. The "active run" is typically a manual ▶ Run, which the queue
// never tracked in `started` — so it surfaces to the scheduler as an external
// active run via StepContext.

test('enqueue while an external run is active auto-starts the (sequential) queue', () => {
  const q = scenario()
    .externalActive(1) // a manual ▶ Run of the same workflow is playing
    .enqueueStep('q1', 'wf1');

  assert.equal(q.state.running, true, 'queue auto-starts on enqueue-while-busy');
  // …but the new entry waits for the active run to finish — no parallel start.
  assert.deepEqual(q.starts, [], 'sequential gate holds q1 behind the external run');
  assert.deepEqual(q.queuedIds(), ['q1']);
  assert.deepEqual(q.state.started, []);
});

test('the auto-started queue dispatches once the external run finishes', () => {
  const q = scenario()
    .externalActive(1)
    .enqueueStep('q1', 'wf1');
  assert.deepEqual(q.starts, []);

  // The manual run completes (leaves activeRuns → runFinished for its runId).
  q.externalActive(0).runFinished('manual-run');
  assert.deepEqual(q.startIds(), ['q1'], 'q1 starts as soon as the slot frees');
  assert.deepEqual(q.state.started, [started('q1', 'wf1', null)]);
});

test('enqueue with nothing active does NOT auto-start the queue', () => {
  const q = scenario().enqueueStep('q1', 'wf1');

  assert.equal(q.state.running, false, 'no active run → still needs an explicit Start');
  assert.deepEqual(q.starts, []);
  assert.deepEqual(q.queuedIds(), ['q1']);
});

test('sequential pendingStarts waits behind an external active run', () => {
  const waiting = queueState({ queued: [queued('q1', 'wf1')], running: true });
  assert.deepEqual(entryIds(pendingStarts(waiting, { externalActiveCount: 1 })), []);
  // Same state, no external run → q1 is free to start.
  assert.deepEqual(entryIds(pendingStarts(waiting, { externalActiveCount: 0 })), ['q1']);
});

test('parallel enqueue-while-busy auto-starts and fires immediately (no external gate)', () => {
  const q = scenario()
    .setMode('parallel')
    .externalActive(1)
    .enqueueStep('q1', 'wf1');

  assert.equal(q.state.running, true);
  // Parallel means "start everything now" — an external run does not gate it.
  assert.deepEqual(q.startIds(), ['q1']);
});
