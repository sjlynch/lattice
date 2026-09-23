import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, started, queued } from './queueScheduler.fixture.ts';

// step(): the dispatch-and-optimistic-update primitive. These drive the queue
// through the scenario harness (reduce + pendingStarts + autoStop in one shot)
// and assert both the emitted `starts` and the resulting state.

test('step dispatches one queued entry per Start', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();

  assert.deepEqual(q.startIds(), ['q1']);
  assert.deepEqual(q.queuedIds(), ['q2']);
  assert.deepEqual(q.state.started, [started('q1', 'wf1', null)]);
  assert.equal(q.state.running, true);
});

test('full flow: duplicate wf1 entries run one after the other with captured overrides', () => {
  const q = scenario()
    .enqueue('q1', 'wf1', 'claude')
    .enqueue('q2', 'wf1', 'pi')
    .startQueue();
  assert.deepEqual(q.startIds(), ['q1']);
  assert.equal(q.starts[0].harnessOverride, 'claude');

  q.workflowStarted('q1', 'run1');
  assert.deepEqual(q.starts, [], 'q2 must not start while q1 is active');

  q.runFinished('run1');
  assert.deepEqual(q.startIds(), ['q2']);
  assert.equal(q.starts[0].harnessOverride, 'pi');

  q.workflowStarted('q2', 'run2').runFinished('run2');
  assert.deepEqual(q.starts, []);
  assert.equal(q.autoStop, true, 'queue should auto-stop when fully drained');
  assert.equal(q.state.running, false);
  assert.deepEqual(q.state.queued, []);
  assert.deepEqual(q.state.started, []);
});

test('a failed dispatch skips to the next queued entry', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();
  assert.deepEqual(q.startIds(), ['q1']);

  q.dispatchFailed('q1');
  assert.deepEqual(q.startIds(), ['q2']);
  assert.deepEqual(q.state.started, [started('q2', 'wf2', null)]);
});

test('stopQueue mid-run prevents further dispatches but leaves the active entry alone', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue()
    .workflowStarted('q1', 'run1')
    .stopQueue();

  assert.equal(q.state.running, false);
  assert.deepEqual(q.state.queued, [queued('q2', 'wf2')]);

  q.runFinished('run1');
  assert.deepEqual(q.starts, []);
  assert.equal(q.state.running, false);
  assert.deepEqual(q.state.started, []);
});

test('workflowStarted twice for the same entry attaches the runId once', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue()
    .workflowStarted('q1', 'run1');

  const before = q.state;
  q.workflowStarted('q1', 'run-different');
  assert.strictEqual(q.state, before);
  assert.deepEqual(q.state.started, [started('q1', 'wf1', 'run1')]);
});

test('rapid double-Start dispatches the head entry only once', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue();

  assert.deepEqual(q.startIds(), ['q1']);

  q.startQueue();
  assert.deepEqual(q.starts, [], 'second Start while already running is a no-op');
  assert.equal(q.state.started.length, 1);
});
