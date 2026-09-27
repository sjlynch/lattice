import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceQueue } from '../components/workflows/queueScheduler.ts';
import { queueState, scenario, started } from './queueScheduler.fixture.ts';
import { queueActionsForStartOutcome } from '../components/workflows/hooks/startOutcomeActions.ts';
import type { WorkflowRun } from '../api';

// ---------- pre-finished runId race ----------
// If WS completed/cancelled arrives before /run HTTP resolves, runFinished is
// dispatched against a started entry whose runId is still null. The scheduler
// must remember the runId so the eventual workflowStarted retires the entry
// instead of attaching a dead id.

test('runFinished before workflowStarted lets the next queued workflow start', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();
  assert.deepEqual(q.startIds(), ['q1']);

  // WS 'completed' arrives before the /run response — q1 has no runId yet.
  q.runFinished('run1');
  assert.deepEqual(q.starts, [], 'queue must wait for workflowStarted to retire q1');
  assert.equal(q.state.started.length, 1, 'q1 is still in-flight from the scheduler view');
  assert.deepEqual(q.state.preFinishedRuns, [{ runId: 'run1', status: 'completed' }]);

  // /run finally resolves and we attach the runId — the entry should be
  // retired in the same step and q2 dispatched.
  q.workflowStarted('q1', 'run1');
  assert.deepEqual(q.startIds(), ['q2'], 'q2 starts once the orphan finish is consumed');
  assert.deepEqual(q.state.preFinishedRuns, [], 'consumed runId is removed');
  assert.equal(q.state.started.length, 1);
  assert.equal(q.state.started[0].id, 'q2');
});

test('runFinished before workflowStarted on the last entry lets autoStop fire', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue();
  assert.deepEqual(q.startedIds(), ['q1']);

  // q1's run finishes before /run resolves.
  q.runFinished('run1');
  assert.equal(q.autoStop, false, 'q1 still pending workflowStarted attachment');

  q.workflowStarted('q1', 'run1');
  assert.equal(q.state.started.length, 0, 'q1 retired by pre-finished consume');
  assert.deepEqual(q.state.preFinishedRuns, []);
  assert.equal(q.autoStop, true, 'the drained queue auto-stops');
  assert.equal(q.state.running, false);
});

test('an unrelated failed run does not stop the queue or match another runId', () => {
  // A manual run completing while the queue is also active leaves an
  // unmatched runId in preFinishedRuns. The next workflowStarted must NOT
  // consume it unless its runId matches.
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue();

  q.runFinished('manual-run', 'errored'); // not q1's run
  assert.deepEqual(q.state.preFinishedRuns, [{ runId: 'manual-run', status: 'errored' }]);
  assert.equal(q.state.running, true);

  q.workflowStarted('unknown-entry', 'manual-run');
  assert.equal(q.state.running, true, 'a run only belongs to a dispatched entry');

  q.workflowStarted('q1', 'run1');
  assert.equal(q.state.started[0].runId, 'run1', 'q1 attaches normally');
  assert.deepEqual(
    q.state.preFinishedRuns,
    [{ runId: 'manual-run', status: 'errored' }],
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
  state = reduceQueue(state, { type: 'runFinished', runId: 'run1', status: 'cancelled' });
  const duplicate = reduceQueue(state, { type: 'runFinished', runId: 'run1', status: 'cancelled' });
  assert.equal(duplicate, state);
  assert.deepEqual(state.preFinishedRuns, [{ runId: 'run1', status: 'cancelled' }]);
});

test('preFinishedRuns is capped, preserving terminal statuses', () => {
  let state = queueState({ running: true });
  for (let i = 0; i < 25; i += 1) {
    state = reduceQueue(state, { type: 'runFinished', runId: `orphan-${i}`, status: 'errored' });
  }
  assert.equal(state.preFinishedRuns.length, 16);
  assert.deepEqual(state.preFinishedRuns[0], { runId: 'orphan-9', status: 'errored' });
  assert.deepEqual(state.preFinishedRuns[15], { runId: 'orphan-24', status: 'errored' });
});

for (const status of ['errored', 'cancelled'] as const) {
  test(`early ${status} stops progression until an explicit restart`, () => {
    const q = scenario().enqueue('q1', 'wf1').enqueue('q2', 'wf2').startQueue();
    q.runFinished('run1', status).runFinished('run1', status);
    assert.equal(q.state.running, true, 'ownership is unknown until the start response arrives');
    assert.deepEqual(q.startIds(), []);

    q.workflowStarted('q1', 'run1');
    assert.equal(q.state.running, false);
    assert.deepEqual(q.startIds(), []);
    assert.deepEqual(q.queuedIds(), ['q2']);
    assert.deepEqual(q.startedIds(), []);
    assert.deepEqual(q.state.preFinishedRuns, []);

    // Duplicate lifecycle delivery and stale retry actions cannot resume it.
    q.runFinished('run1', status).workflowStarted('q1', 'run1');
    q.step({ type: 'retryReady', entryId: 'q1' });
    assert.equal(q.state.running, false);
    assert.deepEqual(q.startIds(), []);
    q.startQueue();
    assert.deepEqual(q.startIds(), ['q2']);
  });
}

for (const status of ['completed', 'errored', 'cancelled'] as const) {
  test(`finished start outcome carries ${status} through the scheduler`, () => {
    const q = scenario().enqueue('q1', 'wf1').enqueue('q2', 'wf2').startQueue();
    const run: WorkflowRun = {
      id: 'run1', workflowId: 'wf1', workflowName: 'First', projectPath: 'C:/p',
      status, startedAt: 0, totalSteps: 1, currentStepIndex: 0,
    };
    for (const action of queueActionsForStartOutcome({ status: 'finished', run }, 'q1', 'C:/p')) {
      q.step(action);
    }
    assert.equal(q.state.running, status === 'completed');
    assert.deepEqual(q.startIds(), status === 'completed' ? ['q2'] : []);
    assert.deepEqual(q.queuedIds(), status === 'completed' ? [] : ['q2']);
    assert.deepEqual(q.state.preFinishedRuns, []);
  });
}
