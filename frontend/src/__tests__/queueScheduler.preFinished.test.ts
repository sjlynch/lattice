import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceQueue } from '../components/workflows/queueScheduler.ts';
import { queueState, scenario, started } from './queueScheduler.fixture.ts';

// ---------- pre-finished runId race ----------
// If WS completed/cancelled arrives before /run HTTP resolves, runFinished is
// dispatched against a started entry whose runId is still null. The scheduler
// must remember the runId so the eventual workflowStarted retires the entry
// instead of attaching a dead id.

test('runFinished before workflowStarted (sequential) lets the next queued workflow start', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();
  assert.deepEqual(q.startIds(), ['q1']);

  // WS 'completed' arrives before the /run response — q1 has no runId yet.
  q.runFinished('run1');
  assert.deepEqual(q.starts, [], 'queue must wait for workflowStarted to retire q1');
  assert.equal(q.state.started.length, 1, 'q1 is still in-flight from the scheduler view');
  assert.deepEqual(q.state.preFinishedRunIds, ['run1']);

  // /run finally resolves and we attach the runId — the entry should be
  // retired in the same step and q2 dispatched.
  q.workflowStarted('q1', 'run1');
  assert.deepEqual(q.startIds(), ['q2'], 'q2 starts once the orphan finish is consumed');
  assert.deepEqual(q.state.preFinishedRunIds, [], 'consumed runId is removed');
  assert.equal(q.state.started.length, 1);
  assert.equal(q.state.started[0].id, 'q2');
});

test('runFinished before workflowStarted (parallel) retires the entry and lets autoStop fire', () => {
  const q = scenario()
    .setMode('parallel')
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();
  assert.deepEqual(q.startedIds().sort(), ['q1', 'q2']);

  // q1's run finishes before /run resolves; q2 dispatches normally.
  q.runFinished('run1');
  q.workflowStarted('q2', 'run2');
  assert.equal(q.autoStop, false, 'q1 still pending workflowStarted attachment');

  q.workflowStarted('q1', 'run1');
  assert.equal(q.state.started.length, 1, 'q1 retired by pre-finished consume');
  assert.deepEqual(q.state.preFinishedRunIds, []);

  q.runFinished('run2');
  assert.equal(q.state.started.length, 0);
});

test('pre-finished runId is consumed only by a matching entryId', () => {
  // A manual run completing while the queue is also active leaves an
  // unmatched runId in preFinishedRunIds. The next workflowStarted must NOT
  // consume it unless its runId matches.
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue();

  q.runFinished('manual-run'); // not q1's run
  assert.deepEqual(q.state.preFinishedRunIds, ['manual-run']);

  q.workflowStarted('q1', 'run1');
  assert.equal(q.state.started[0].runId, 'run1', 'q1 attaches normally');
  assert.deepEqual(
    q.state.preFinishedRunIds,
    ['manual-run'],
    'unrelated runId is left for ageing',
  );

  q.runFinished('run1');
  assert.equal(q.state.started.length, 0, 'q1 retires through the normal path');
});

test('duplicate runFinished for the same runId does not double-buffer', () => {
  let state = queueState({
    running: true,
    started: [started('q1', 'wf1', null)],
  });
  state = reduceQueue(state, { type: 'runFinished', runId: 'run1' });
  state = reduceQueue(state, { type: 'runFinished', runId: 'run1' });
  assert.deepEqual(state.preFinishedRunIds, ['run1']);
});

test('preFinishedRunIds is capped to prevent unbounded growth', () => {
  let state = queueState({ running: true });
  for (let i = 0; i < 25; i += 1) {
    state = reduceQueue(state, { type: 'runFinished', runId: `orphan-${i}` });
  }
  assert.equal(state.preFinishedRunIds.length, 16);
  assert.equal(state.preFinishedRunIds[0], 'orphan-9', 'oldest entries drop off the front');
  assert.equal(state.preFinishedRunIds[15], 'orphan-24');
});
